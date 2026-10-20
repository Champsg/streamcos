const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { transcodeToHLS, extractThumbnail } = require('./transcoder');
const { getSecret, hashPassword, verifyPassword, createToken, verifyToken, extractToken } = require('./auth');

const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'data.json');
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure upload directories exist
fs.mkdirSync(path.join(UPLOADS_DIR, 'videos'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'posters'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'hls'), { recursive: true });

// shortcut: in-memory + single data.json file storage instead of postgres/mongodb, upgrade when scaling multi-instance or high write throughput.
// shortcut: standard library http server instead of express/fastify, upgrade when adding middleware or complex routing.

const SEED_CATALOG = [
  { id:"sintel", title:"Sintel", year:2010, mins:15, rating:"8.1", quality:"4K", category:"Fantasy",
    price:299, oldPrice:499, views:18400, featured:true, published:true,
    poster:"assets/poster-sintel.jpg", video:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
    desc:"A lonely young wanderer crosses a frozen wasteland searching for Scales, the baby dragon she once rescued and lost. Colin Levy's wordless fantasy about love, obsession and letting go." },
  { id:"tears-of-steel", title:"Tears of Steel", year:2012, mins:12, rating:"7.4", quality:"HD", category:"Sci-Fi",
    price:249, oldPrice:399, views:15200, featured:false, published:true,
    poster:"assets/poster-tears-of-steel.jpg", video:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
    desc:"Forty years after giant machines tore Amsterdam apart, a group of scientists and robots restages the day it all went wrong." },
  { id:"spring", title:"Spring", year:2019, mins:8, rating:"7.9", quality:"4K", category:"Fantasy",
    price:199, oldPrice:299, views:12800, featured:false, published:true,
    poster:"assets/poster-spring.jpg", video:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
    desc:"High in the mountains, a shepherd girl and her loyal dog must face the ancient spirits of the forest to coax the season back to life." },
  { id:"agent-327", title:"Agent 327: Operation Barbershop", year:2017, mins:4, rating:"7.8", quality:"HD", category:"Comedy",
    price:149, oldPrice:249, views:9700, featured:false, published:true,
    poster:"assets/poster-agent-327.jpg", video:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
    desc:"Hendrik IJzerbroot — Agent 327, Holland's most accident-prone secret agent — pops into a barbershop for a quick trim and walks straight into a trap." },
  { id:"big-buck-bunny", title:"Big Buck Bunny", year:2008, mins:10, rating:"7.6", quality:"HD", category:"Family",
    price:0, oldPrice:0, views:22100, featured:false, published:true,
    poster:"assets/poster-big-buck-bunny.jpg", video:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    desc:"The gentle giant of the forest loves butterflies, berries and quiet mornings — until three bullying rodents push him one prank too far. Free for everyone, forever." },
  { id:"elephants-dream", title:"Elephants Dream", year:2006, mins:11, rating:"6.9", quality:"HD", category:"Sci-Fi",
    price:179, oldPrice:279, views:6400, featured:false, published:true,
    poster:"assets/poster-elephants-dream.jpg", video:"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    desc:"Inside an infinite, ever-shifting Machine, the elder Proog tries to open young Emo's eyes to its wonders — but Emo begins to doubt everything he is shown." }
];

let db = {
  serverSecret: null,
  catalog: SEED_CATALOG.slice(),
  users: [],
  owns: {},
  passHolders: {},
  progress: {},
  sales: [],
  ownerPinHash: null,
  ownerPinSalt: null
};

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const loaded = JSON.parse(raw);
      db = Object.assign(db, loaded);

      // Auto-migrate server secret
      if (!db.serverSecret) {
        db.serverSecret = getSecret();
      }

      // Auto-migrate legacy ownerPin to salted hash
      if (db.ownerPin && !db.ownerPinHash) {
        const p = hashPassword(db.ownerPin);
        db.ownerPinHash = p.hash;
        db.ownerPinSalt = p.salt;
        delete db.ownerPin;
      }

      // Auto-migrate legacy users to salted hashes
      if (Array.isArray(db.users)) {
        db.users.forEach(u => {
          if (u.pass && !u.passHash) {
            const p = hashPassword(u.pass);
            u.passHash = p.hash;
            u.passSalt = p.salt;
            delete u.pass;
          }
        });
      }
      saveDb();
    } else {
      db.serverSecret = getSecret();
      saveDb();
    }
  } catch (err) {
    console.error('Failed to load data.json, using defaults:', err.message);
    if (!db.serverSecret) db.serverSecret = getSecret();
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save data.json:', err.message);
  }
}

loadDb();

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Filename, X-Auto-HLS, X-Token'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5e6) { req.destroy(); reject(new Error('Payload too large')); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
  });
}

function requireUser(req, searchParams) {
  const token = extractToken(req, searchParams);
  const payload = verifyToken(token, db.serverSecret);
  if (!payload || !payload.email) return null;
  return payload;
}

function requireOwner(req, searchParams) {
  const token = extractToken(req, searchParams);
  const payload = verifyToken(token, db.serverSecret);
  if (!payload || payload.role !== 'owner') return null;
  return payload;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/MP2T'
};

function serveStatic(req, res, pathname) {
  const clean = (pathname || '/').replace(/^(\.\.[\/\\])+/, '').replace(/^[\\\/]+/, '');
  const relativeFile = clean === '' ? 'index.html' : clean;
  const filePath = path.join(FRONTEND_DIR, relativeFile);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveUpload(req, res, pathname, searchParams) {
  const clean = pathname.slice('/uploads/'.length).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(UPLOADS_DIR, clean);

  // Posters and misc non-video assets are public for catalog thumbnails
  const isVideoMedia = clean.startsWith('videos/') || clean.startsWith('hls/');
  if (isVideoMedia) {
    const token = extractToken(req, searchParams);
    const decoded = verifyToken(token, db.serverSecret);
    const isAuthorized = decoded && (decoded.role === 'owner' || decoded.access === 'paid' || decoded.access === 'free');
    
    // Also allow if this specific video file belongs to a free catalog title
    const isCatalogFree = db.catalog.some(c => Number(c.price || 0) === 0 && c.video && c.video.includes(clean));

    if (!isAuthorized && !isCatalogFree) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Unauthorized stream: valid playback token required' }));
      return;
    }
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Support HTTP Range requests for MP4 seeking
    const range = req.headers.range;
    if (range && ext === '.mp4') {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const searchParams = reqUrl.searchParams;
  const method = req.method.toUpperCase();

  // CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Filename, X-Auto-HLS, X-Token'
    });
    res.end();
    return;
  }

  // --- Protected Media Uploads (/uploads/*) ---
  if (pathname.startsWith('/uploads/')) {
    return serveUpload(req, res, pathname, searchParams);
  }

  // --- API Routes ---
  if (pathname.startsWith('/api/')) {
    try {
      // Health
      if (pathname === '/api/health' && method === 'GET') {
        return json(res, 200, { status: 'ok', secured: true, time: Date.now() });
      }

      // Network Info
      if (pathname === '/api/network-info' && method === 'GET') {
        const nets = os.networkInterfaces();
        const ips = [];
        for (const name of Object.keys(nets)) {
          for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
          }
        }
        return json(res, 200, {
          port: PORT,
          localIps: ips,
          urls: ips.map(ip => `http://${ip}:${PORT}`)
        });
      }

      // Direct Video / Poster Upload (Requires Owner Token)
      if (pathname === '/api/upload' && method === 'POST') {
        const owner = requireOwner(req, searchParams);
        if (!owner) {
          return json(res, 401, { error: 'Owner authentication required for video upload' });
        }

        const rawName = decodeURIComponent(req.headers['x-filename'] || 'file_' + Date.now());
        const ext = path.extname(rawName).toLowerCase() || '.mp4';
        const isVideo = ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext);
        const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
        const subFolder = isVideo ? 'videos' : (isImage ? 'posters' : 'misc');
        const safeBase = path.basename(rawName, ext).replace(/[^a-zA-Z0-9_\-]/g, '_');
        const filename = `${safeBase}_${Date.now()}${ext}`;
        const destDir = path.join(UPLOADS_DIR, subFolder);
        fs.mkdirSync(destDir, { recursive: true });
        const targetPath = path.join(destDir, filename);

        const writeStream = fs.createWriteStream(targetPath);
        req.pipe(writeStream);

        writeStream.on('finish', async () => {
          const publicUrl = `/uploads/${subFolder}/${filename}`;
          let hlsUrl = null;
          let autoPoster = null;

          const wantHls = req.headers['x-auto-hls'] === 'true' || isVideo;
          if (isVideo && wantHls) {
            const videoId = 'hls_' + Date.now().toString(36);
            try {
              const transRes = await transcodeToHLS(targetPath, path.join(UPLOADS_DIR, 'hls'), videoId);
              hlsUrl = transRes.hlsUrl;
              autoPoster = transRes.posterUrl;
            } catch (err) {
              console.warn('HLS transcoding failed, falling back to raw video:', err.message);
            }
          }

          return json(res, 201, {
            ok: true,
            url: hlsUrl || publicUrl,
            rawUrl: publicUrl,
            hlsUrl,
            posterUrl: autoPoster,
            filename,
            isVideo
          });
        });

        writeStream.on('error', (err) => {
          return json(res, 500, { error: 'Failed to write upload: ' + err.message });
        });
        return;
      }

      // Catalog GET (Public)
      if (pathname === '/api/catalog' && method === 'GET') {
        return json(res, 200, { catalog: db.catalog });
      }

      // Catalog POST (Requires Owner Token)
      if (pathname === '/api/catalog' && method === 'POST') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });

        const body = await readBody(req);
        if (!body.title || !body.video) {
          return json(res, 400, { error: 'Title and video URL are required' });
        }
        const item = {
          id: body.id || 'v' + Date.now().toString(36),
          title: body.title.trim(),
          year: parseInt(body.year, 10) || new Date().getFullYear(),
          mins: parseInt(body.mins, 10) || 10,
          rating: body.rating || 'New',
          quality: body.quality || 'HD',
          category: body.category || 'Drama',
          price: parseInt(body.price, 10) || 0,
          oldPrice: parseInt(body.oldPrice, 10) || 0,
          views: body.views || 0,
          featured: !!body.featured,
          published: body.published !== false,
          poster: body.poster || 'assets/poster-spring.jpg',
          video: body.video,
          desc: body.desc || ''
        };
        db.catalog.unshift(item);
        saveDb();
        return json(res, 201, { ok: true, film: item });
      }

      // Catalog PUT /api/catalog/:id (Requires Owner Token)
      if (pathname.startsWith('/api/catalog/') && method === 'PUT') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });

        const id = pathname.slice('/api/catalog/'.length);
        const body = await readBody(req);
        const idx = db.catalog.findIndex(c => c.id === id);
        if (idx === -1) return json(res, 404, { error: 'Film not found' });
        db.catalog[idx] = Object.assign({}, db.catalog[idx], body);
        saveDb();
        return json(res, 200, { ok: true, film: db.catalog[idx] });
      }

      // Catalog DELETE /api/catalog/:id (Requires Owner Token)
      if (pathname.startsWith('/api/catalog/') && method === 'DELETE') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });

        const id = pathname.slice('/api/catalog/'.length);
        db.catalog = db.catalog.filter(c => c.id !== id);
        saveDb();
        return json(res, 200, { ok: true });
      }

      // Auth Register
      if (pathname === '/api/auth/register' && method === 'POST') {
        const { name, email, pass } = await readBody(req);
        const cleanEmail = (email || '').trim().toLowerCase();
        if (!cleanEmail || !pass || pass.length < 4 || !name) {
          return json(res, 400, { error: 'Name, valid email and 4+ character password required' });
        }
        if (db.users.find(u => u.email === cleanEmail)) {
          return json(res, 400, { error: 'That email already has an account — sign in instead.' });
        }
        const { hash, salt } = hashPassword(pass);
        const user = { name: name.trim(), email: cleanEmail, passHash: hash, passSalt: salt, joined: Date.now() };
        db.users.push(user);
        saveDb();
        const token = createToken({ email: cleanEmail, name: user.name }, db.serverSecret);
        return json(res, 201, {
          ok: true,
          token,
          user: { name: user.name, email: user.email, joined: user.joined }
        });
      }

      // Auth Login
      if (pathname === '/api/auth/login' && method === 'POST') {
        const { email, pass } = await readBody(req);
        const cleanEmail = (email || '').trim().toLowerCase();
        const user = db.users.find(u => u.email === cleanEmail);
        if (!user || !verifyPassword(pass, user.passHash, user.passSalt)) {
          return json(res, 401, { error: 'Invalid email or password' });
        }
        const token = createToken({ email: cleanEmail, name: user.name }, db.serverSecret);
        return json(res, 200, {
          ok: true,
          token,
          user: { name: user.name, email: user.email, joined: user.joined }
        });
      }

      // User Data GET (Requires Valid User Token)
      if (pathname === '/api/user/data' && method === 'GET') {
        const user = requireUser(req, searchParams);
        if (!user) {
          return json(res, 401, { error: 'Valid user token required' });
        }
        const email = user.email;
        return json(res, 200, {
          email,
          owns: db.owns[email] || [],
          hasPass: !!db.passHolders[email],
          progress: db.progress[email] || {}
        });
      }

      // Purchase POST (Requires Authenticated User Token)
      if (pathname === '/api/purchase' && method === 'POST') {
        const user = requireUser(req, searchParams);
        if (!user) {
          return json(res, 401, { error: 'Sign in required to make purchases' });
        }
        const { videoId, price } = await readBody(req);
        const cleanEmail = user.email;
        if (!videoId) return json(res, 400, { error: 'videoId required' });

        if (videoId === 'pass') {
          db.passHolders[cleanEmail] = true;
          db.sales.push({ videoId: 'pass', price: price || 99, ts: Date.now(), email: cleanEmail });
        } else {
          if (!db.owns[cleanEmail]) db.owns[cleanEmail] = [];
          if (!db.owns[cleanEmail].includes(videoId)) {
            db.owns[cleanEmail].push(videoId);
          }
          db.sales.push({ videoId, price: price || 0, ts: Date.now(), email: cleanEmail });
        }
        saveDb();
        return json(res, 200, {
          ok: true,
          owns: db.owns[cleanEmail] || [],
          hasPass: !!db.passHolders[cleanEmail]
        });
      }

      // Progress POST (Requires Authenticated User Token)
      if (pathname === '/api/progress' && method === 'POST') {
        const user = requireUser(req, searchParams);
        if (!user) return json(res, 401, { error: 'Sign in required' });
        const { videoId, t, d } = await readBody(req);
        const cleanEmail = user.email;
        if (!videoId) return json(res, 400, { error: 'Missing fields' });
        if (!db.progress[cleanEmail]) db.progress[cleanEmail] = {};
        db.progress[cleanEmail][videoId] = { t: Number(t || 0), d: Number(d || 0) };
        saveDb();
        return json(res, 200, { ok: true });
      }

      // Signed Playback Token Gatekeeper
      if (pathname === '/api/player/token' && method === 'POST') {
        const { videoId } = await readBody(req);
        if (!videoId) return json(res, 400, { error: 'videoId required' });

        const film = db.catalog.find(c => c.id === videoId);
        const isFree = !film || Number(film.price || 0) === 0;

        if (isFree) {
          const playToken = createToken({ videoId, access: 'free' }, db.serverSecret, 4 * 3600);
          return json(res, 200, { ok: true, playToken, videoUrl: film ? film.video : null });
        }

        // Owner override
        const owner = requireOwner(req, searchParams);
        if (owner) {
          const playToken = createToken({ videoId, role: 'owner', access: 'paid' }, db.serverSecret, 4 * 3600);
          return json(res, 200, { ok: true, playToken, videoUrl: film.video });
        }

        const user = requireUser(req, searchParams);
        if (!user) {
          return json(res, 401, { error: 'Sign in required to stream this premium film', requiresAuth: true });
        }

        const hasPass = !!db.passHolders[user.email];
        const ownsFilm = Array.isArray(db.owns[user.email]) && db.owns[user.email].includes(videoId);

        if (!hasPass && !ownsFilm) {
          return json(res, 403, { error: 'Pass or film purchase required to unlock this title', requiresPass: true });
        }

        const playToken = createToken({ videoId, email: user.email, access: 'paid' }, db.serverSecret, 4 * 3600);
        return json(res, 200, { ok: true, playToken, videoUrl: film.video });
      }

      // Admin Stats GET (Requires Owner Token)
      if (pathname === '/api/admin/stats' && method === 'GET') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });

        const revenue = db.sales.reduce((sum, s) => sum + (s.price || 0), 0);
        return json(res, 200, {
          totalFilms: db.catalog.length,
          publishedFilms: db.catalog.filter(f => f.published).length,
          salesCount: db.sales.length,
          revenue,
          sales: db.sales
        });
      }

      // Admin Verify / Set PIN
      if (pathname === '/api/admin/verify-pin' && method === 'POST') {
        const { pin, newPin } = await readBody(req);
        if (!db.ownerPinHash) {
          if (newPin && newPin.length === 4) {
            const p = hashPassword(newPin);
            db.ownerPinHash = p.hash;
            db.ownerPinSalt = p.salt;
            saveDb();
            const ownerToken = createToken({ role: 'owner' }, db.serverSecret, 12 * 3600);
            return json(res, 200, { ok: true, setup: true, ownerToken });
          }
          return json(res, 200, { ok: false, needsSetup: true });
        }
        if (verifyPassword(pin, db.ownerPinHash, db.ownerPinSalt)) {
          const ownerToken = createToken({ role: 'owner' }, db.serverSecret, 12 * 3600);
          return json(res, 200, { ok: true, ownerToken });
        }
        return json(res, 401, { ok: false, error: 'Wrong PIN' });
      }

      return json(res, 404, { error: 'Unknown API endpoint' });
    } catch (err) {
      console.error('Server error:', err);
      return json(res, 500, { error: err.message || 'Internal Server Error' });
    }
  }

  // --- Static Frontend Serving ---
  serveStatic(req, res, pathname);
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
    console.log(`StreamCos running at:`);
    console.log(`- Local:   http://localhost:${PORT}`);
    ips.forEach(ip => console.log(`- Network: http://${ip}:${PORT}`));
  });
}

module.exports = server;
