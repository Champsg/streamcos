'use strict';

/**
 * Headless UI smoke test for the checkout, driven over the Chrome DevTools
 * Protocol. Proves the real page (not just the API) renders the fixed QR,
 * accepts a UTR and flips to the unlocked state.
 *
 * Usage: node scripts/ui-smoke.js <appPort> <cdpPort> <outDir>
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_PORT = Number(process.argv[2] || 5090);
const CDP_PORT = Number(process.argv[3] || 9223);
const OUT_DIR = process.argv[4] || path.join(process.cwd(), 'scripts', 'ui-shots');
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targetRes = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(APP_URL)}`,
    { method: 'PUT' }
  );
  const target = await targetRes.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const jsErrors = [];
  const consoleErrors = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      jsErrors.push((d.exception && d.exception.description) || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error('Page error: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  };

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 932, deviceScaleFactor: 2, mobile: true
  });

  await send('Page.navigate', { url: APP_URL });
  for (let i = 0; i < 60; i += 1) {
    const state = await evaluate('document.readyState');
    if (state === 'complete') break;
    await sleep(250);
  }
  await sleep(1500);

  const results = [];
  const check = (label, condition, extra = '') => {
    results.push({ label, pass: !!condition, extra: String(extra).slice(0, 200) });
    console.log(`${condition ? '  ✔' : '  ✖'} ${label}${extra ? ' — ' + extra : ''}`);
  };

  const title = await evaluate('document.title');
  check('page loaded', title.includes('StreamCos'), title);
  await shot('01-home.png');

  // Sign in through the real API, then reload so the app boots authenticated.
  const email = `ui${Date.now()}@test.local`;
  const reg = await evaluate(`(async () => {
    const r = await fetch('/api/auth/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: 'UI Tester', email: '${email}', pass: 'secret123' })
    }).then(r => r.json());
    localStorage.setItem('sc_token', r.token);
    localStorage.setItem('sv_session', JSON.stringify(r.user));
    return r.token ? 'ok' : 'fail';
  })()`);
  check('signed-in session stored', reg === 'ok', email);

  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  const cfgLoaded = await evaluate('(function(){var q=document.querySelector("[data-buy]"); return q ? q.textContent.trim() : "none";})()');
  check('pass banner shows the ₹99.99 price from the server config', cfgLoaded.includes('99.99'), cfgLoaded);

  await evaluate('document.querySelector("[data-buy]").click()');
  await sleep(2000);

  const sheet = await evaluate(`(function(){
    const s = document.getElementById('paySheet');
    const img = s.querySelector('.upi-qr-card img');
    return {
      open: s.classList.contains('on'),
      qrSrc: img ? img.getAttribute('src') : null,
      qrLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
      text: s.innerText.slice(0, 400),
      hasUtr: !!s.querySelector('#utrInput'),
      vpa: s.querySelector('#upiPillTxt') ? s.querySelector('#upiPillTxt').textContent : null
    };
  })()`);

  check('checkout sheet opened', sheet.open);
  check('fixed QR image is shown', String(sheet.qrSrc || '').includes('youpi-qr.png'), sheet.qrSrc);
  check('QR image actually decoded by the browser', sheet.qrLoaded);
  check('amount shown is ₹99.99', sheet.text.includes('99.99'));
  check('merchant VPA shown', String(sheet.vpa).includes('muskaanlimited379042.rzp@rxairtel'), sheet.vpa);
  check('UTR input present', sheet.hasUtr);
  await shot('02-checkout.png');

  // Invalid UTR must not unlock anything.
  await evaluate(`(function(){
    document.getElementById('utrInput').value = '123';
    document.getElementById('verifyUtrBtn').click();
  })()`);
  await sleep(1200);
  const afterBad = await evaluate(`(function(){
    return {
      toast: document.getElementById('toast').textContent,
      stillForm: !!document.getElementById('utrInput'),
      sheet: document.getElementById('paySheet').innerText
    };
  })()`);
  check('short UTR is rejected in the UI', /12-digit/i.test(afterBad.toast) && afterBad.stillForm, afterBad.toast);

  // Valid UTR unlocks.
  const utr = String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  await evaluate(`(function(){
    document.getElementById('utrInput').value = '${utr}';
    document.getElementById('verifyUtrBtn').click();
  })()`);

  let unlocked = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const txt = await evaluate(`document.getElementById('paySheet').innerText`);
    if (/Everything is unlocked/i.test(txt)) { unlocked = true; break; }
  }
  check('valid UTR unlocks the pass in the UI', unlocked, 'utr=' + utr);
  await sleep(3000); // let the transient toast clear before the screenshot
  await shot('03-unlocked.png');

  const state = await evaluate(`(function(){
    return {
      pass: localStorage.getItem('sv_pass'),
      banner: document.getElementById('passSlot') ? document.getElementById('passSlot').innerText.slice(0, 80) : ''
    };
  })()`);
  check('client entitlement persisted', state.pass === 'true', state.pass);
  check('home banner switched to active', /active/i.test(state.banner), state.banner.replace(/\n/g, ' '));

  // Owner studio renders the payments ledger.
  await evaluate(`(async () => {
    const status = await fetch('/api/admin/owner-status').then(r => r.json());
    let token = null;
    if (!status.configured) {
      const setup = await fetch('/api/admin/verify-pin', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ newPin: '1234', setupCode: 'UISMOKE' })
      }).then(r => r.json());
      token = setup.ownerToken;
    } else {
      const pin = await fetch('/api/admin/verify-pin', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ pin: '1234' })
      }).then(r => r.json());
      token = pin.ownerToken;
    }
    sessionStorage.setItem('sc_owner_token', token);
  })()`);
  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await evaluate(`(function(){
    window.scrollTo(0,0);
    document.querySelector('#hdrAvatar').click();
    return true;
  })()`);
  await sleep(600);
  await evaluate(`(function(){ document.querySelector('#ownerStudioBtn').click(); return true; })()`);
  await sleep(600);
  await evaluate(`(function(){
    const inp = document.getElementById('pinInput');
    inp.value = '1234';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('pinForm').requestSubmit();
    return true;
  })()`);
  await sleep(2500);
  const adminOk = await evaluate(`!!document.querySelector('#paymentsLedgerBtn')`);
  check('owner studio loads with payment controls', adminOk);
  if (adminOk) {
    await evaluate(`document.querySelector('#paymentsLedgerBtn').click()`);
    await sleep(1500);
    const ledgerText = await evaluate(`document.getElementById('videoFormSlot').innerText`);
    check('ledger lists the paid order', /PAID|Paid/i.test(ledgerText) && ledgerText.includes('99.99'), ledgerText.split('\n').slice(0, 3).join(' | '));
    await shot('04-ledger.png');
  }

  check('no uncaught JS exceptions', jsErrors.length === 0, jsErrors.join(' | '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
  if (consoleErrors.length) {
    console.log('console.error output (informational):');
    consoleErrors.slice(0, 5).forEach((c) => console.log('  ·', c));
  }
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('UI smoke test crashed:', err);
  process.exit(1);
});
