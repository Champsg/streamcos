const { spawn, execSync } = require('child_process');
const os = require('os');
const path = require('path');

// 1. Free port 5000 and kill old tunnel instances if running
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

serverProc.stdout.on('data', (d) => {
  // Silent or info
});

// 3. Find Local Network IPs
const nets = os.networkInterfaces();
const localIps = [];
for (const name of Object.keys(nets)) {
  for (const net of nets[name]) {
    if (net.family === 'IPv4' && !net.internal) localIps.push(net.address);
  }
}

// 4. Start Cloudflare Public Tunnel
console.log('Creating secure Cloudflare edge tunnel for worldwide access...\n');
const tunnelProc = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5000'], {
  stdio: ['ignore', 'pipe', 'pipe']
});

let publicUrl = null;
const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

function printBanner() {
  console.log('\x1b[32m%s\x1b[0m', '✔ ALL SYSTEMS ONLINE — STREAMING FROM YOUR PC 24/7');
  console.log('----------------------------------------------------------');
  console.log('\x1b[1m[1] On this PC:\x1b[0m           http://localhost:5000');
  localIps.forEach(ip => {
    console.log(`\x1b[1m[2] Local Wi-Fi (Phones):\x1b[0m http://${ip}:5000`);
  });
  if (publicUrl) {
    console.log(`\x1b[33m\x1b[1m[3] Worldwide Public URL:\x1b[0m ${publicUrl}`);
  } else {
    console.log('\x1b[33m[3] Worldwide Public URL:\x1b[0m Connecting tunnel...');
  }
  console.log('----------------------------------------------------------');
  console.log('• Keep this window open to keep your platform live 24/7.');
  console.log('• Press Ctrl+C at any time to stop.\n');
}

tunnelProc.stdout.on('data', (data) => {
  const text = data.toString();
  const match = text.match(urlRegex);
  if (match && !publicUrl) {
    publicUrl = match[0];
    console.clear();
    printBanner();
  }
});

tunnelProc.stderr.on('data', (data) => {
  const text = data.toString();
  const match = text.match(urlRegex);
  if (match && !publicUrl) {
    publicUrl = match[0];
    console.clear();
    printBanner();
    // Auto-open browser
    try {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'http://localhost:5000'], { detached: true, stdio: 'ignore' });
      }
    } catch(e){}
  }
});

setTimeout(() => {
  if (!publicUrl) printBanner();
}, 6000);

// Cleanup on exit
function shutdown() {
  console.log('\nShutting down StreamCos cleanly...');
  try { serverProc.kill(); } catch(e){}
  try { tunnelProc.kill(); } catch(e){}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
