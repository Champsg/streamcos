const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Free port 5000 and clean up old instances
try {
  if (process.platform === 'win32') {
    try {
      const output = execSync('netstat -ano | findstr :5000', { encoding: 'utf8' });
      const lines = output.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(pid) && parseInt(pid, 10) > 0) {
          try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch(e){}
        }
      }
    } catch (e) {}
    try { execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' }); } catch(e){}
  }
} catch (e) {}

console.clear();
console.log('\x1b[36m%s\x1b[0m', '==========================================================');
console.log('\x1b[33m%s\x1b[0m', '      STREAMCOS — 24/7 ALL-IN-ONE PC STREAMING PLATFORM   ');
console.log('\x1b[36m%s\x1b[0m', '==========================================================');
console.log('Booting Backend Server and Hovod Transcoding Engine...');

// 2. Start Backend Server
const serverProc = spawn(process.execPath, [path.join(__dirname, 'backend', 'server.js')], {
  stdio: ['ignore', 'pipe', 'inherit']
});

// 3. Find Local Network IPs
const nets = os.networkInterfaces();
const localIps = [];
for (const name of Object.keys(nets)) {
  for (const net of nets[name]) {
    if (net.family === 'IPv4' && !net.internal) localIps.push(net.address);
  }
}

let publicUrl = null;
let tunnelProc = null;

function printBanner() {
  console.log('\x1b[32m%s\x1b[0m', '✔ ALL SYSTEMS ONLINE — STREAMING FROM YOUR PC 24/7');
  console.log('----------------------------------------------------------');
  console.log('\x1b[1m[1] On this PC:\x1b[0m           http://localhost:5000');
  localIps.forEach(ip => {
    console.log(`\x1b[1m[2] Local Wi-Fi (Phones):\x1b[0m http://${ip}:5000`);
  });
  if (publicUrl) {
    console.log(`\x1b[33m\x1b[1m[3] Worldwide Public Link:\x1b[0m ${publicUrl}`);
    console.log('\x1b[32m    (Cloudflare Edge Protected — ZERO warning screens)\x1b[0m');
  } else {
    console.log('\x1b[33m[3] Worldwide Public Link:\x1b[0m Connecting Cloudflare tunnel...');
  }
  console.log('----------------------------------------------------------');
  console.log('• Keep this window open to keep your platform live 24/7.');
  console.log('• Press Ctrl+C at any time to stop.\n');
}

// Cloudflare Tunnel (Clean, no warning screens, 100% free)
tunnelProc = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5000'], {
  stdio: ['ignore', 'pipe', 'pipe']
});

const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const onData = (data) => {
  const match = data.toString().match(urlRegex);
  if (match && !publicUrl) {
    publicUrl = match[0];
    console.clear();
    printBanner();
  }
};
tunnelProc.stdout.on('data', onData);
tunnelProc.stderr.on('data', onData);

setTimeout(() => {
  if (!publicUrl) printBanner();
}, 6000);

// Auto-open browser
setTimeout(() => {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'http://localhost:5000'], { detached: true, stdio: 'ignore' });
    }
  } catch (e) {}
}, 2500);

// Cleanup on exit
function shutdown() {
  console.log('\nShutting down StreamCos cleanly...');
  try { serverProc.kill(); } catch(e){}
  try { if (tunnelProc) tunnelProc.kill(); } catch(e){}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
