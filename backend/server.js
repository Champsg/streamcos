const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { transcodeToHLS, extractThumbnail } = require('./transcoder');
const { getSecret, hashPassword, verifyPassword, createToken, verifyToken, extractToken } = require('./auth');
const payments = require('./payments');
const previews = require('./previews');
const reconcile = require('./reconcile');
const ownerAuth = require('./owner');
const store = require('./store');
const { createLimiters } = require('./ratelimit');

const PORT = process.env.PORT || 5000;
const DATA_FILE = process.env.STREAMCOS_DATA_FILE
  ? path.resolve(process.env.STREAMCOS_DATA_FILE)
  : path.join(__dirname, 'data.json');
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure upload directories exist
fs.mkdirSync(path.join(UPLOADS_DIR, 'videos'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'posters'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'hls'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, previews.PREVIEW_DIR), { recursive: true });

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
  payments: [],
  webhookDeliveries: [],
  ownerPinHash: null,
  ownerPinSalt: null,
  ownerSetup: null,
  paymentConfig: payments.normalizeConfig(null)
};

function loadDb() {
  store.cleanupTempFiles(DATA_FILE);

  const loaded = store.load(DATA_FILE);
  if (loaded.recovered) {
    console.warn('⚠  Store was unreadable; recovered the previous good copy from ' +
      path.basename(store.backupPath(DATA_FILE)) +
      (loaded.error ? ' (' + loaded.error.message + ')' : ''));
  } else if (loaded.error && loaded.error.code !== 'ENOENT') {
    console.error('Failed to load the store, starting from defaults:', loaded.error.message);
  }

  if (loaded.data) {
    db = Object.assign(db, loaded.data);
  }

  // Payments: migrate legacy {upiId, merchantName, qrImage} config, make
  // sure the ledgers exist, then expire any sessions left open by a crash.
  db.paymentConfig = payments.normalizeConfig(db.paymentConfig);
  if (!Array.isArray(db.payments)) db.payments = [];
  if (!Array.isArray(db.webhookDeliveries)) db.webhookDeliveries = [];

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

  payments.sweepExpired(db, Date.now());
  saveDb();
}

function saveDb() {
  try {
    store.save(DATA_FILE, db);
  } catch (err) {
    // Never pretend a write succeeded: payment routes rely on state being
    // durable before they answer the client.
    console.error('CRITICAL: failed to persist the store:', err.message);
  }
}

loadDb();

/* First-run ownership: a setup code printed here (or supplied through
 * STREAMCOS_SETUP_CODE) is required to create the studio PIN. Without it the
 * first visitor to a fresh deployment could claim the studio. */
function bootstrapOwnerSetup() {
  if (db.ownerPinHash) {
    if (db.ownerSetup) { db.ownerSetup = null; saveDb(); }
    return;
  }

  const envCode = String(process.env.STREAMCOS_SETUP_CODE || '').trim();
  if (envCode) {
    const { record } = ownerAuth.createSetupRecord(envCode);
    db.ownerSetup = record;
    saveDb();
    console.log('Owner setup code is set from STREAMCOS_SETUP_CODE.');
    return;
  }

  if (!db.ownerSetup) {
    const { record, code } = ownerAuth.createSetupRecord();
    db.ownerSetup = record;
    saveDb();
    console.log('');
    console.log('  ┌───────────────────────────────────────────────');
    console.log('  │ First run — no Owner Studio PIN is set yet.');
    console.log('  │ Setup code: ' + code);
    console.log('  │ Enter it with a new 4-digit PIN in Account → Owner Studio.');
    console.log('  └───────────────────────────────────────────────');
    console.log('');
  }
}
bootstrapOwnerSetup();

const limiters = createLimiters();

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

function isLoopback(address) {
  return address === '::1' ||
    address === '127.0.0.1' ||
    address === '::ffff:127.0.0.1' ||
    /^::ffff:127\./.test(address || '');
}

function clientIp(req) {
  const remote = (req.socket && req.socket.remoteAddress) || 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  // Only the local tunnel process (cloudflared/ngrok) may speak for the
  // client. A direct client that could set X-First-For would otherwise dodge
  // every rate limit by rotating a header.
  if (typeof forwarded === 'string' && forwarded.length && isLoopback(remote)) {
    return forwarded.split(',')[0].trim() || remote;
  }
  return remote;
}

function send429(res, verdict) {
  const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(seconds),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({
    error: 'Too many attempts — try again in ' + seconds + 's',
    retryAfter: seconds
  }));
}

/** Applies a limiter; sends 429 and returns true when the caller must stop. */
function rateLimit(req, res, limiter, suffix) {
  if (limiters.disabled) return false;
  const verdict = limiter.take(clientIp(req) + (suffix ? '|' + suffix : ''));
  if (verdict.allowed) return false;
  send429(res, verdict);
  return true;
}

/** Check-only: used where only *failures* should burn quota (login, PIN). */
function limitBlocked(req, res, limiter, suffix) {
  if (limiters.disabled) return false;
  const verdict = limiter.peek(clientIp(req) + (suffix ? '|' + suffix : ''));
  if (verdict.allowed) return false;
  send429(res, verdict);
  return true;
}

function limitCount(req, limiter, suffix) {
  if (limiters.disabled) return;
  limiter.take(clientIp(req) + (suffix ? '|' + suffix : ''));
}

function readRawBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); reject(new Error('Payload too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Grants the All-Access Pass for a PAID order. Idempotent: re-running it (poll,
 * webhook replay, owner approve) never duplicates the sale ledger entry.
 */
function fulfillPaidOrder(order) {
  if (!order || order.status !== payments.STATUS.PAID) return false;
  const email = order.email;
  if (!email) return false;
  let changed = false;

  if (!db.passHolders) db.passHolders = {};
  if (!db.passHolders[email]) { db.passHolders[email] = true; changed = true; }

  if (!Array.isArray(db.sales)) db.sales = [];
  if (!db.sales.some((sale) => sale.orderId === order.id)) {
    db.sales.push({
      orderId: order.id,
      videoId: 'pass',
      price: order.amountPaise / 100,
      ts: order.paidAt || Date.now(),
      email,
      utr: order.utr || null,
      method: 'UPI',
      source: order.source || 'utr'
    });
    changed = true;
  }

  if (changed) saveDb();
  return true;
}

const CLAIM_ERRORS = {
  NOT_FOUND: [404, 'Payment session not found'],
  BAD_UTR: [400, 'Enter the 12-digit UPI reference (UTR) printed on your payment receipt'],
  DUPLICATE_CLAIM: [400, 'That UTR was already submitted for this checkout'],
  UTR_USED: [409, 'That UTR is already linked to another payment'],
  TOO_MANY_ATTEMPTS: [429, 'Too many attempts for this checkout — start a new one'],
  EXPIRED: [410, 'This checkout expired — start a new one and pay again'],
  REJECTED: [410, 'This payment was rejected — start a new checkout'],
  CANCELLED: [410, 'This checkout was cancelled']
};

function isUpiVpa(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(value.trim());
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

/**
 * A film "owns" either its whole HLS directory or one exact file. Matching is
 * exact/prefix based — never substring — so `hls_1` cannot unlock `hls_10`,
 * and a token minted for one title cannot fetch another title's media.
 */
function mediaScope(videoUrl) {
  if (typeof videoUrl !== 'string' || !videoUrl.startsWith('/uploads/')) return null;
  const rel = videoUrl.slice('/uploads/'.length);
  if (!rel) return null;
  if (rel.endsWith('.m3u8')) {
    const cut = rel.lastIndexOf('/');
    return cut === -1 ? { type: 'file', value: rel } : { type: 'dir', value: rel.slice(0, cut + 1) };
  }
  return { type: 'file', value: rel };
}

function mediaMatches(scope, rel) {
  if (!scope) return false;
  return scope.type === 'dir' ? rel.startsWith(scope.value) : rel === scope.value;
}

function filmForMedia(rel) {
  return db.catalog.find((film) => mediaMatches(mediaScope(film.video), rel)) || null;
}

function previewOwnerOf(rel) {
  const prefix = previews.PREVIEW_DIR + '/';
  if (!rel.startsWith(prefix)) return null;
  return rel.slice(prefix.length).replace(/\.mp4$/i, '');
}

function denyMedia(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Media authorization:
 *   previews/<id>.mp4  → only a token for exactly that title (or the owner)
 *   hls/<folder>/…     → the token must belong to the film that owns the folder
 *   videos/<file>.mp4  → exact file match
 * Free titles stay public. Preview tokens are never valid for full media.
 */
function authorizeMedia(req, res, searchParams, rel) {
  const decoded = verifyToken(extractToken(req, searchParams), db.serverSecret);
  const isOwner = Boolean(decoded && decoded.role === 'owner');

  const previewId = previewOwnerOf(rel);
  if (previewId !== null) {
    const ok = isOwner || Boolean(decoded &&
      decoded.videoId === previewId &&
      ['preview', 'paid', 'free'].includes(decoded.access));
    if (!ok) {
      denyMedia(res, 403, 'A preview token for this title is required');
      return false;
    }
    return true;
  }

  const film = filmForMedia(rel);
  if (!film) {
    if (isOwner) return true;
    denyMedia(res, 403, 'This media is not part of the catalogue');
    return false;
  }
  if (Number(film.price || 0) === 0) return true;

  const ownsToken = Boolean(decoded &&
    decoded.videoId === film.id &&
    ['paid', 'free'].includes(decoded.access));
  if (isOwner || ownsToken) return true;

  denyMedia(res, 403, 'A valid playback token for this title is required');
  return false;
}

function serveUpload(req, res, pathname, searchParams) {
  const clean = pathname.slice('/uploads/'.length).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(UPLOADS_DIR, clean);

  // Posters and misc non-video assets stay public for catalog thumbnails.
  const isProtectedMedia = clean.startsWith('videos/') ||
    clean.startsWith('hls/') ||
    clean.startsWith(previews.PREVIEW_DIR + '/');
  if (isProtectedMedia && !authorizeMedia(req, res, searchParams, clean)) return;

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

const previewJobs = new Map();

/** Local filesystem path for a catalogue title's source, or null if remote. */
function localMediaPath(videoUrl) {
  const scope = mediaScope(videoUrl);
  if (!scope) return null;
  if (scope.type === 'file') return path.join(UPLOADS_DIR, scope.value);
  return path.join(UPLOADS_DIR, scope.value + 'master.m3u8');
}

/**
 * Renders (once) the 45-second preview for a title. Returns null when the
 * title has no local media or ffmpeg cannot produce a clip — callers must
 * refuse the preview rather than fall back to the full stream.
 */
async function ensureFilmPreview(film) {
  if (!film) return null;
  if (previewJobs.has(film.id)) return previewJobs.get(film.id);

  const job = (async () => {
    const source = localMediaPath(film.video);
    try {
      return await previews.ensure(film.id, source, UPLOADS_DIR);
    } catch (err) {
      console.warn('Preview unavailable for "' + film.id + '": ' + err.message);
      return null;
    }
  })().finally(() => previewJobs.delete(film.id));

  previewJobs.set(film.id, job);
  return job;
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Filename, X-Auto-HLS, X-Token, Range, ngrok-skip-browser-warning',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
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
      // Cheap global ceiling: a runaway client cannot hammer scrypt or the
      // payment state machine from one address.
      if (rateLimit(req, res, limiters.api)) return;

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
        if (rateLimit(req, res, limiters.upload)) return;

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

        const maxBytes = Number(process.env.STREAMCOS_MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024);
        let received = 0;
        let aborted = false;

        const writeStream = fs.createWriteStream(targetPath);
        req.pipe(writeStream);

        req.on('data', (chunk) => {
          if (aborted) return;
          received += chunk.length;
          if (received > maxBytes) {
            aborted = true;
            writeStream.destroy();
            try { fs.unlinkSync(targetPath); } catch (e) {}
            json(res, 413, {
              error: 'Upload exceeds the limit of ' + Math.round(maxBytes / (1024 * 1024)) + ' MB'
            });
            req.destroy();
          }
        });

        writeStream.on('finish', async () => {
          if (aborted) return;
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
        if (rateLimit(req, res, limiters.register)) return;
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
        if (limitBlocked(req, res, limiters.login)) return;
        const { email, pass } = await readBody(req);
        const cleanEmail = (email || '').trim().toLowerCase();
        const user = db.users.find(u => u.email === cleanEmail);
        if (!user || !verifyPassword(pass, user.passHash, user.passSalt)) {
          limitCount(req, limiters.login);
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

      // ---------- Payments: YouPI-style UPI checkout ----------
      const nowMs = Date.now();

      // Public payment config — everything the checkout needs to draw the QR.
      if (pathname === '/api/payment/config' && method === 'GET') {
        const cfg = payments.normalizeConfig(db.paymentConfig);
        return json(res, 200, {
          ok: true,
          config: payments.publicConfig(cfg),
          links: payments.upiLinks(cfg),
          sessionTtlMs: payments.TTL_MS
        });
      }

      // Create (or resume) the signed-in account's single open order.
      if (pathname === '/api/pay/orders' && method === 'POST') {
        const user = requireUser(req, searchParams);
        if (!user) return json(res, 401, { error: 'Sign in required to start a payment' });
        if (rateLimit(req, res, limiters.order, user.email)) return;

        const cfg = payments.normalizeConfig(db.paymentConfig);
        const { order, reused } = payments.createOrder(db, user.email, cfg, nowMs);
        saveDb();
        return json(res, 201, {
          ok: true,
          reused,
          order: payments.publicOrder(order, nowMs),
          config: payments.publicConfig(cfg),
          links: payments.upiLinks(cfg)
        });
      }

      // Poll an order. Also re-asserts entitlement if a webhook paid it earlier.
      if (pathname.startsWith('/api/pay/orders/') &&
          !pathname.endsWith('/claim') && !pathname.endsWith('/cancel') &&
          method === 'GET') {
        const user = requireUser(req, searchParams);
        if (!user) return json(res, 401, { error: 'Sign in required' });

        const id = decodeURIComponent(pathname.slice('/api/pay/orders/'.length));
        const order = payments.findOrder(db, id);
        if (!order || order.email !== user.email) {
          return json(res, 404, { error: 'Payment session not found' });
        }
        if (payments.sweepExpired(db, nowMs)) saveDb();
        fulfillPaidOrder(order);
        return json(res, 200, {
          ok: true,
          order: payments.publicOrder(order, nowMs),
          hasPass: !!db.passHolders[user.email]
        });
      }

      // Payer submits the UTR / Ref No. from their UPI receipt.
      if (/^\/api\/pay\/orders\/[^/]+\/claim$/.test(pathname) && method === 'POST') {
        const user = requireUser(req, searchParams);
        if (!user) return json(res, 401, { error: 'Sign in required' });
        if (rateLimit(req, res, limiters.claim, user.email)) return;

        const id = decodeURIComponent(pathname.slice('/api/pay/orders/'.length, -'/claim'.length));
        const order = payments.findOrder(db, id);
        if (!order || order.email !== user.email) {
          return json(res, 404, { error: 'Payment session not found' });
        }

        const body = await readBody(req);
        const cfg = payments.normalizeConfig(db.paymentConfig);
        const result = payments.claimPayment(db, order, body.utr, {
          now: nowMs,
          ip: clientIp(req),
          cfg
        });

        if (result.order && result.order.status === payments.STATUS.PAID) {
          fulfillPaidOrder(result.order);
        }
        saveDb();

        if (!result.ok) {
          const [status, message] = CLAIM_ERRORS[result.code] || [400, 'Payment could not be verified'];
          return json(res, status, {
            ok: false,
            code: result.code,
            error: message,
            order: payments.publicOrder(result.order, nowMs)
          });
        }

        return json(res, 200, {
          ok: true,
          code: result.code,
          order: payments.publicOrder(result.order, nowMs),
          hasPass: !!db.passHolders[user.email],
          owns: (db.owns && db.owns[user.email]) || []
        });
      }

      // Customer abandons the checkout.
      if (/^\/api\/pay\/orders\/[^/]+\/cancel$/.test(pathname) && method === 'POST') {
        const user = requireUser(req, searchParams);
        if (!user) return json(res, 401, { error: 'Sign in required' });

        const id = decodeURIComponent(pathname.slice('/api/pay/orders/'.length, -'/cancel'.length));
        const order = payments.findOrder(db, id);
        if (!order || order.email !== user.email) {
          return json(res, 404, { error: 'Payment session not found' });
        }
        if (payments.OPEN_STATUSES.includes(order.status)) {
          order.status = payments.STATUS.CANCELLED;
          order.resolvedAt = nowMs;
          saveDb();
        }
        return json(res, 200, { ok: true, order: payments.publicOrder(order, nowMs) });
      }

      // ---------- YouPI-compatible server-to-server webhook ----------
      // Signature is HMAC-SHA256 over the RAW bytes; never trust the frontend.
      if (pathname === '/api/youpi/webhook' && method === 'POST') {
        const rawBody = await readRawBody(req);
        const cfg = payments.normalizeConfig(db.paymentConfig);
        const result = payments.handleWebhook(db, rawBody, req.headers, cfg, nowMs);

        if (result.ok && result.order) {
          fulfillPaidOrder(result.order);
          saveDb();
        }
        return json(res, result.status || (result.ok ? 200 : 400), {
          ok: result.ok,
          code: result.code
        });
      }

      // Owner: payment configuration (VPA, amount, verification mode, QR).
      if (pathname === '/api/admin/payment/config' && method === 'POST') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });

        const body = await readBody(req);
        const cfg = payments.normalizeConfig(db.paymentConfig);

        if (body.vpa != null || body.upiId != null) {
          const vpa = String(body.vpa != null ? body.vpa : body.upiId).trim();
          if (!isUpiVpa(vpa)) return json(res, 400, { error: 'Enter a valid UPI ID like name@bank' });
          cfg.vpa = vpa;
          cfg.upiId = vpa;
        }
        if (body.payeeName != null || body.merchantName != null) {
          const name = String(body.payeeName != null ? body.payeeName : body.merchantName).trim();
          if (!name) return json(res, 400, { error: 'Merchant display name is required' });
          cfg.payeeName = name;
          cfg.merchantName = name;
        }
        if (body.amountPaise != null || body.amount != null) {
          const paise = body.amountPaise != null
            ? Math.round(Number(body.amountPaise))
            : Math.round(Number(body.amount) * 100);
          if (!Number.isFinite(paise) || paise < 100 || paise > 10000000) {
            return json(res, 400, { error: 'Amount must be between ₹1 and ₹1,00,000' });
          }
          cfg.amountPaise = paise;
        }
        if (body.verification != null) {
          if (!['instant', 'manual'].includes(body.verification)) {
            return json(res, 400, { error: 'Verification mode must be instant or manual' });
          }
          cfg.verification = body.verification;
        }
        if (body.qrImage !== undefined) {
          const qr = body.qrImage ? String(body.qrImage) : null;
          if (qr !== cfg.qrImage) {
            cfg.qrImage = qr;
            // A different file means the pinned hash/payload no longer apply.
            cfg.qrSha256 = qr === payments.DEFAULTS.qrImage ? payments.DEFAULTS.qrSha256 : null;
            cfg.qrPayload = qr === payments.DEFAULTS.qrImage ? payments.DEFAULTS.qrPayload : null;
          }
        }
        if (body.rotateWebhookSecret) {
          cfg.webhookSecret = payments.normalizeConfig({ webhookSecret: null }).webhookSecret;
        }

        db.paymentConfig = cfg;
        saveDb();
        return json(res, 200, {
          ok: true,
          config: payments.publicConfig(cfg),
          webhookSecret: cfg.webhookSecret
        });
      }

      // Owner: payment ledger + pending claims.
      if (pathname === '/api/admin/payments' && method === 'GET') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });

        if (payments.sweepExpired(db, nowMs)) saveDb();
        const cfg = payments.normalizeConfig(db.paymentConfig);
        const orders = (db.payments || [])
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 100)
          .map((o) => Object.assign(payments.publicOrder(o, nowMs), { email: o.email }));

        return json(res, 200, {
          ok: true,
          stats: payments.paymentStats(db),
          orders,
          config: Object.assign(payments.publicConfig(cfg), {
            webhookSecret: cfg.webhookSecret,
            webhookPath: '/api/youpi/webhook'
          })
        });
      }

      // Owner: approve or reject a claimed payment.
      if (/^\/api\/admin\/payments\/[^/]+\/resolve$/.test(pathname) && method === 'POST') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });

        const id = decodeURIComponent(pathname.slice('/api/admin/payments/'.length, -'/resolve'.length));
        const body = await readBody(req);
        const action = body.action === 'approve' ? 'approve' : body.action === 'reject' ? 'reject' : null;
        if (!action) return json(res, 400, { error: 'action must be approve or reject' });

        const order = payments.findOrder(db, id);
        if (!order) return json(res, 404, { error: 'Payment not found' });

        const result = payments.resolvePayment(db, order, action, {
          now: nowMs,
          note: body.note ? String(body.note).slice(0, 200) : null
        });
        if (!result.ok) {
          const [status, message] = CLAIM_ERRORS[result.code] || [400, 'Could not update payment'];
          return json(res, status, { ok: false, code: result.code, error: message });
        }
        if (result.code === 'PAID') fulfillPaidOrder(result.order);
        saveDb();
        return json(res, 200, {
          ok: true,
          order: Object.assign(payments.publicOrder(result.order, nowMs), { email: result.order.email })
        });
      }

      // Owner: match pasted bank-statement credits to open orders.
      if (pathname === '/api/admin/payments/reconcile' && method === 'POST') {
        const owner = requireOwner(req, searchParams);
        if (!owner) return json(res, 401, { error: 'Owner authentication required' });
        if (rateLimit(req, res, limiters.reconcile)) return;

        const body = await readBody(req);
        const text = String(body.text || '');
        if (!text.trim()) return json(res, 400, { error: 'Paste your statement lines (or a CSV export) first' });

        const result = reconcile.reconcile(db, text, Date.now());
        for (const match of result.matched) {
          const order = payments.findOrder(db, match.orderId);
          if (order) fulfillPaidOrder(order);
        }
        if (result.matched.length) saveDb();

        return json(res, 200, {
          ok: true,
          credits: result.credits,
          matched: result.matched,
          unmatched: result.unmatched,
          stats: payments.paymentStats(db)
        });
      }

      // Legacy endpoint: it trusted a client-supplied price and UTR, so it is
      // retired in favour of /api/pay/orders + /claim.
      if (pathname === '/api/purchase' && method === 'POST') {
        return json(res, 410, {
          error: 'Direct purchase is retired. Use /api/pay/orders and submit the UTR to /api/pay/orders/:id/claim.'
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
        const { videoId, isPreview } = await readBody(req);
        if (!videoId) return json(res, 400, { error: 'videoId required' });

        const film = db.catalog.find(c => c.id === videoId);
        if (!film) return json(res, 404, { error: 'Title not found' });
        const isFree = Number(film.price || 0) === 0;

        // Free titles play as-is, and a "preview" of a free title is just the title.
        if (isFree) {
          const playToken = createToken({ videoId, access: 'free' }, db.serverSecret, 4 * 3600);
          return json(res, 200, { ok: true, playToken, videoUrl: film.video });
        }

        if (isPreview) {
          // A preview is a separate 45-second clip. If it cannot be rendered
          // (no local source, ffmpeg missing) we refuse rather than hand over
          // the full stream.
          const preview = await ensureFilmPreview(film);
          if (!preview) {
            return json(res, 503, {
              error: 'Preview is not available for this title — it needs local media on the StreamCos host.',
              previewUnavailable: true
            });
          }
          const playToken = createToken({ videoId, access: 'preview' }, db.serverSecret, 30 * 60);
          return json(res, 200, {
            ok: true,
            playToken,
            videoUrl: preview.url,
            preview: true,
            previewSeconds: previews.PREVIEW_SECONDS
          });
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

      // Public: tells the client whether to show "unlock" or "first-run setup".
      // Reveals nothing beyond whether a PIN exists.
      if (pathname === '/api/admin/owner-status' && method === 'GET') {
        return json(res, 200, {
          configured: Boolean(db.ownerPinHash),
          setupRequired: !db.ownerPinHash
        });
      }

      // Admin Verify / Set PIN
      // - entering the PIN is rate limited per client and globally, because a
      //   4-digit space is only ~10k guesses;
      // - the first-run PIN additionally requires the setup code printed by
      //   the server, so an exposed fresh install cannot be claimed by a
      //   stranger;
      // - a forgotten PIN is recovered with `node backend/reset-pin.js`.
      if (pathname === '/api/admin/verify-pin' && method === 'POST') {
        if (limitBlocked(req, res, limiters.pin)) return;
        const { pin, newPin, setupCode } = await readBody(req);

        if (!db.ownerPinHash) {
          if (!newPin) {
            return json(res, 200, { ok: false, needsSetup: true, setupRequired: true });
          }
          if (!db.ownerSetup) {
            limitCount(req, limiters.pin);
            return json(res, 409, {
              ok: false,
              error: 'Owner setup state is missing. Run `node backend/reset-pin.js --yes` on the server.'
            });
          }
          if (!ownerAuth.verifySetupCode(setupCode, db.ownerSetup)) {
            limitCount(req, limiters.pin);
            return json(res, 401, {
              ok: false,
              error: 'Setup code is missing or incorrect — it was printed in the server console.'
            });
          }
          if (!/^\d{4}$/.test(String(newPin))) {
            limitCount(req, limiters.pin);
            return json(res, 400, { ok: false, error: 'PIN must be exactly 4 digits' });
          }

          const p = hashPassword(newPin);
          db.ownerPinHash = p.hash;
          db.ownerPinSalt = p.salt;
          db.ownerSetup = null;
          saveDb();
          const ownerToken = createToken({ role: 'owner' }, db.serverSecret, 12 * 3600);
          return json(res, 200, { ok: true, setup: true, ownerToken });
        }

        if (!/^\d{4}$/.test(String(pin || ''))) {
          limitCount(req, limiters.pin);
          return json(res, 401, { ok: false, error: 'Wrong PIN' });
        }
        if (verifyPassword(pin, db.ownerPinHash, db.ownerPinSalt)) {
          const ownerToken = createToken({ role: 'owner' }, db.serverSecret, 12 * 3600);
          return json(res, 200, { ok: true, ownerToken });
        }
        limitCount(req, limiters.pin);
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
