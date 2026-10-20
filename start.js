'use strict';

/**
 * One-click launcher: backend + optional Cloudflare quick tunnel.
 *
 * Deliberately conservative:
 *   - it never kills processes it did not start, unless you pass --force and
 *     it can name the process holding the port;
 *   - a missing `cloudflared` degrades to LAN-only instead of crashing;
 *   - when the tunnel hands out a hostname it records it in
 *     frontend/runtime-config.js and netlify.toml, so the deployed frontend
 *     keeps working without editing code.
 *
 * Flags: --force  --no-tunnel  --port <n>  --subdomain <name>  --tunnel <localtunnel|cloudflare>  --token <cf-token>
 */

const { spawn, execSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const NO_TUNNEL = args.includes('--no-tunnel');
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 && args[portFlag + 1] ? Number(args[portFlag + 1]) : Number(process.env.PORT || 5000);

const subdomainFlag = args.indexOf('--subdomain');
const SUBDOMAIN = subdomainFlag >= 0 && args[subdomainFlag + 1] ? args[subdomainFlag + 1] : (process.env.STREAMCOS_SUBDOMAIN || 'streamcos-play');

const tokenFlag = args.indexOf('--token');
const TUNNEL_TOKEN = tokenFlag >= 0 && args[tokenFlag + 1] ? args[tokenFlag + 1] : (process.env.CLOUDFLARE_TUNNEL_TOKEN || null);

const tunnelFlag = args.indexOf('--tunnel');
const TUNNEL_TYPE = tunnelFlag >= 0 && args[tunnelFlag + 1]
  ? args[tunnelFlag + 1]
  : (args.includes('--cloudflare') || TUNNEL_TOKEN ? 'cloudflare' : 'localtunnel');

const ROOT = __dirname;
const TUNNEL_FILE = path.join(ROOT, '.streamcos-tunnel.json');

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
  });
}

/** Best-effort "who owns this port" for a helpful, non-destructive message. */
function findPortOwner(port) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const listening = out.split(/\r?\n/).find((line) => /LISTENING/i.test(line));
    if (!listening) return null;
    const pid = Number(listening.trim().split(/\s+/).pop());
    if (!pid) return null;
    let name = 'unknown';
    try {
      const csv = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      name = (csv.split(',')[0] || 'unknown').replace(/"/g, '');
    } catch (e) {}
    return { pid, name };
  } catch (e) {
    return null;
  }
}

function line(text, color) {
  const palette = { cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
  console.log((palette[color] || '') + text + palette.reset);
}

function localIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name] || []) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) ips.push(netInfo.address);
    }
  }
  return ips;
}

async function main() {
  console.log('');
  line('  STREAMCOS — streaming platform for your own PC', 'cyan');
  console.log('');

  if (!(await isPortFree(PORT))) {
    const owner = findPortOwner(PORT);
    console.error(`  Port ${PORT} is already in use` + (owner ? ` by ${owner.name} (PID ${owner.pid}).` : '.'));
    console.error('  Stop that process, pick another port with --port <n>, or replace it with:');
    console.error('      npm start -- --force');
    if (!FORCE) process.exit(1);
    if (!owner) {
      console.error('  --force was given but the owner could not be identified; refusing to kill blindly.');
      process.exit(1);
    }
    console.log(`  --force: stopping ${owner.name} (PID ${owner.pid}) only.`);
    try { execSync(`taskkill /F /PID ${owner.pid}`, { stdio: 'ignore' }); } catch (e) {}
    await new Promise((r) => setTimeout(r, 600));
  }

  const serverProc = spawn(process.execPath, [path.join(ROOT, 'backend', 'server.js')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: Object.assign({}, process.env, { PORT: String(PORT) })
  });
  serverProc.stdout.on('data', (chunk) => process.stdout.write(chunk));
  serverProc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error('  Backend exited with code ' + code + '. Stopping.');
      shutdown(code || 1);
    }
  });

  let tunnelProc = null;
  let tunnelInstance = null;
  let publicUrl = null;

  function banner() {
    console.log('');
    line('  ALL SYSTEMS ONLINE', 'green');
    console.log('  ' + '-'.repeat(52));
    console.log('  Local:        http://localhost:' + PORT);
    localIps().forEach((ip) => console.log('  Wi-Fi:        http://' + ip + ':' + PORT));
    console.log('  Public:       ' + (publicUrl || (NO_TUNNEL ? 'disabled (--no-tunnel)' : 'connecting…')));
    console.log('  ' + '-'.repeat(52));
    console.log('  Ctrl+C stops the backend and this tunnel process only.');
    console.log('');
  }

  function handleTunnelUrl(url) {
    if (publicUrl === url) return;
    publicUrl = url;
    try {
      const { updateConfig } = require('./scripts/set-api-base');
      updateConfig(publicUrl);
      fs.writeFileSync(TUNNEL_FILE, JSON.stringify({ url: publicUrl, at: Date.now() }, null, 2));
      line('  Permanent Public Link: ' + publicUrl, 'yellow');
      line('  frontend/runtime-config.js and netlify.toml point to this permanent link.', 'dim');
    } catch (err) {
      line('  Could not record the tunnel URL: ' + err.message, 'yellow');
    }
    banner();
  }

  async function connectLocaltunnel() {
    try {
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
      tunnelInstance = tunnel;
      handleTunnelUrl(tunnel.url);

      tunnel.on('close', () => {
        if (!shuttingDown) {
          line('  Tunnel closed — reconnecting in 3s...', 'dim');
          setTimeout(connectLocaltunnel, 3000);
        }
      });
      tunnel.on('error', (err) => {
        if (!shuttingDown) {
          line('  Tunnel warning: ' + (err ? err.message : 'connection glitch'), 'dim');
        }
      });
    } catch (err) {
      if (!shuttingDown) {
        line('  Localtunnel failed (' + (err ? err.message : 'error') + '). Retrying in 4s...', 'yellow');
        setTimeout(connectLocaltunnel, 4000);
      }
    }
  }

  function connectCloudflare() {
    const cfArgs = TUNNEL_TOKEN
      ? ['tunnel', 'run', '--token', TUNNEL_TOKEN]
      : ['tunnel', '--url', `http://localhost:${PORT}`];

    tunnelProc = spawn('cloudflared', cfArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    tunnelProc.on('error', (err) => {
      tunnelProc = null;
      if (err.code === 'ENOENT') {
        line('  cloudflared not found — continuing on your local network only.', 'yellow');
        line('  Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/', 'dim');
      } else {
        line('  Tunnel failed: ' + err.message + ' — continuing on your local network only.', 'yellow');
      }
      banner();
    });

    const onTunnelData = (data) => {
      const match = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) handleTunnelUrl(match[0]);
    };

    tunnelProc.stdout.on('data', onTunnelData);
    tunnelProc.stderr.on('data', onTunnelData);
  }

  if (!NO_TUNNEL) {
    if (TUNNEL_TYPE === 'cloudflare') {
      connectCloudflare();
    } else {
      connectLocaltunnel();
    }
  }

  setTimeout(banner, NO_TUNNEL ? 1200 : 8000);

  if (process.platform === 'win32') {
    setTimeout(() => {
      try {
        spawn('cmd.exe', ['/c', 'start', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
      } catch (e) {}
    }, 2500);
  }

  let shuttingDown = false;
  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  Shutting down StreamCos…');
    try { serverProc.kill(); } catch (e) {}
    try { if (tunnelInstance) tunnelInstance.close(); } catch (e) {}
    try { if (tunnelProc) tunnelProc.kill(); } catch (e) {}
    setTimeout(() => process.exit(code), 150);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((err) => {
  console.error('Launcher failed:', err);
  process.exit(1);
});
