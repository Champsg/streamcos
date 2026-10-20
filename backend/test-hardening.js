'use strict';

/**
 * Hardening regression suite for the fixes in this round:
 *   1. preview tokens can no longer stream a full paid film
 *   2. the store is written atomically and recovers from a corrupt file
 *   3. the owner PIN is rate limited and needs a first-run setup code
 *   4. auth / payment / upload routes are rate limited
 *   5. bank-credit reconciliation can confirm payments from a statement
 *   6. media authorization is exact (no substring, no cross-title tokens)
 *   8. start.js no longer kills unrelated processes
 *
 * Run: node backend/test-hardening.js
 */

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `streamcos-hardening-${process.pid}.json`);
const UPLOADS = path.join(__dirname, 'uploads');
const CREATED = [];

process.env.STREAMCOS_DATA_FILE = TMP_DB;
process.env.STREAMCOS_SETUP_CODE = 'HARDEN';
process.env.STREAMCOS_RL_API_MAX = '5000';
process.env.STREAMCOS_RL_REGISTER_MAX = '2';
process.env.STREAMCOS_RL_PIN_MAX = '6';
process.env.STREAMCOS_RL_LOGIN_MAX = '5';
process.env.STREAMCOS_RL_ORDER_MAX = '50';
process.env.STREAMCOS_RL_CLAIM_MAX = '50';

const store = require('./store');
const reconcile = require('./reconcile');
const server = require('./server');

const PORT = Number(process.env.HARDEN_TEST_PORT || 5188);
const BASE = `http://127.0.0.1:${PORT}`;

let checks = 0;
function ok(label) {
  checks += 1;
  console.log('  ✔ ' + label);
}

async function call(pathname, { method = 'GET', token, body, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, headers: res.headers, res };
}

function touch(relPath, bytes = 2048) {
  const file = path.join(UPLOADS, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 65));
  CREATED.push(file);
  return file;
}

async function main() {
  /* ------------------------------------------------------- store atomicity */
  console.log('\n▸ Crash-safe store');
  const storeFile = path.join(os.tmpdir(), `store-atomic-${process.pid}.json`);
  store.save(storeFile, { generation: 1 });
  store.save(storeFile, { generation: 2 });
  assert.strictEqual(store.load(storeFile).data.generation, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(storeFile, 'utf8')).generation, 2);
  ok('save() replaces the file atomically and keeps a .bak of the previous state');

  fs.writeFileSync(storeFile, '{"generation": 2, "truncated":', 'utf8'); // simulate crash mid-write
  const recovered = store.load(storeFile);
  assert.strictEqual(recovered.recovered, true);
  assert.strictEqual(recovered.data.generation, 1);
  assert(fs.readdirSync(os.tmpdir()).some((n) => n.startsWith(path.basename(storeFile) + '.corrupt-')));
  ok('a truncated store is quarantined and the previous good copy is recovered');
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(path.basename(storeFile))) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (e) {} }
  }

  /* ---------------------------------------------------------- owner PIN */
  console.log('\n▸ Owner PIN hardening');
  const status0 = await call('/api/admin/owner-status');
  assert.strictEqual(status0.body.configured, false);

  const noCode = await call('/api/admin/verify-pin', { method: 'POST', body: { newPin: '1234' } });
  assert.strictEqual(noCode.status, 401);
  assert.match(String(noCode.body.error), /setup code/i);

  const wrongCode = await call('/api/admin/verify-pin', {
    method: 'POST', body: { newPin: '1234', setupCode: 'WRONGCODE' }
  });
  assert.strictEqual(wrongCode.status, 401);
  ok('a fresh install cannot be claimed without the console setup code');

  const setup = await call('/api/admin/verify-pin', {
    method: 'POST', body: { newPin: '1234', setupCode: 'HARDEN' }
  });
  assert.strictEqual(setup.status, 200);
  assert(setup.body.ownerToken);
  const owner = setup.body.ownerToken;
  const status1 = await call('/api/admin/owner-status');
  assert.strictEqual(status1.body.configured, true);
  ok('setup code + PIN creates the owner session and clears the setup state');

  const failureStatuses = [];
  for (let i = 0; i < 4; i += 1) {
    const bad = await call('/api/admin/verify-pin', { method: 'POST', body: { pin: '000' + i } });
    failureStatuses.push(bad.status);
  }
  assert.deepStrictEqual(failureStatuses, [401, 401, 401, 401]);
  ok('wrong PINs are rejected');

  const locked = await call('/api/admin/verify-pin', { method: 'POST', body: { pin: '1234' } });
  assert.strictEqual(locked.status, 429);
  assert(Number(locked.headers.get('retry-after')) > 0);
  ok('PIN attempts are rate limited (correct PIN is blocked too once locked)');

  /* ------------------------------------------------------ register limits */
  console.log('\n▸ Rate limits');
  const reg1 = await call('/api/auth/register', {
    method: 'POST', body: { name: 'One', email: 'one@hard.test', pass: 'secret123' }
  });
  assert.strictEqual(reg1.status, 201);
  const reg2 = await call('/api/auth/register', {
    method: 'POST', body: { name: 'Two', email: 'two@hard.test', pass: 'secret123' }
  });
  assert.strictEqual(reg2.status, 201);
  const reg3 = await call('/api/auth/register', {
    method: 'POST', body: { name: 'Three', email: 'three@hard.test', pass: 'secret123' }
  });
  assert.strictEqual(reg3.status, 429);
  assert(Number(reg3.headers.get('retry-after')) > 0);
  ok('registration is capped per client (2 allowed, 3rd is 429)');

  const user1 = reg1.body.token;
  const user2 = reg2.body.token;

  /* ------------------------------------------------------- media scoping */
  console.log('\n▸ Media authorization');
  touch('hls/hls_hardA/master.m3u8');
  touch('hls/hls_hardB/master.m3u8');
  touch('hls/hls_hardF/master.m3u8');

  const filmA = await call('/api/catalog', {
    method: 'POST', token: owner,
    body: { id: 'hardA', title: 'Paid A', video: '/uploads/hls/hls_hardA/master.m3u8', price: 299 }
  });
  assert.strictEqual(filmA.status, 201);
  await call('/api/catalog', {
    method: 'POST', token: owner,
    body: { id: 'hardB', title: 'Paid B', video: '/uploads/hls/hls_hardB/master.m3u8', price: 199 }
  });
  await call('/api/catalog', {
    method: 'POST', token: owner,
    body: { id: 'hardF', title: 'Free F', video: '/uploads/hls/hls_hardF/master.m3u8', price: 0 }
  });

  // Give user1 a pass through a real order, so it can mint paid tokens.
  const ord = await call('/api/pay/orders', { method: 'POST', token: user1, body: {} });
  const pay = await call(`/api/pay/orders/${ord.body.order.id}/claim`, {
    method: 'POST', token: user1, body: { utr: '300000000001' }
  });
  assert.strictEqual(pay.body.order.status, 'PAID');

  const tokA = await call('/api/player/token', { method: 'POST', token: user1, body: { videoId: 'hardA' } });
  assert.strictEqual(tokA.status, 200);

  const noTokenB = await call('/uploads/hls/hls_hardB/master.m3u8');
  assert.strictEqual(noTokenB.status, 403);
  const crossTitle = await call('/uploads/hls/hls_hardB/master.m3u8', { token: tokA.body.playToken });
  assert.strictEqual(crossTitle.status, 403);
  const ownTitle = await call('/uploads/hls/hls_hardA/master.m3u8', { token: tokA.body.playToken });
  assert.strictEqual(ownTitle.status, 200, 'own title is authorized and served');
  ok('a playback token only opens its own title (cross-title fetch is 403)');

  const freeMedia = await call('/uploads/hls/hls_hardF/master.m3u8');
  assert.strictEqual(freeMedia.status, 200, 'free title is public');
  ok('free titles stay public');

  // A token for a paid title cannot open the orphan folder of another id.
  const orphan = await call('/uploads/hls/hls_hardB/720p/index.m3u8', { token: tokA.body.playToken });
  assert.strictEqual(orphan.status, 403);
  ok('HLS sub-playlists stay inside the same title scope');

  /* ------------------------------------------------------- real previews */
  console.log('\n▸ Preview clips');
  touch('previews/hardD.mp4', 4096);
  await call('/api/catalog', {
    method: 'POST', token: owner,
    body: { id: 'hardD', title: 'Paid D', video: '/uploads/hls/hls_hardD/master.m3u8', price: 199 }
  });
  await call('/api/catalog', {
    method: 'POST', token: owner,
    body: { id: 'hardE', title: 'Remote paid', video: 'https://example.com/film.mp4', price: 199 }
  });

  const prevD = await call('/api/player/token', { method: 'POST', token: user1, body: { videoId: 'hardD', isPreview: true } });
  assert.strictEqual(prevD.status, 200);
  assert.strictEqual(prevD.body.videoUrl, '/uploads/previews/hardD.mp4');
  assert.strictEqual(prevD.body.preview, true);
  ok('a preview resolves to a separate short clip, not the film');

  const fullWithPreview = await call('/uploads/hls/hls_hardD/master.m3u8', { token: prevD.body.playToken });
  assert.strictEqual(fullWithPreview.status, 403);
  ok('a preview token cannot open the full film');

  const previewNoToken = await call('/uploads/previews/hardD.mp4');
  assert.strictEqual(previewNoToken.status, 403);
  const previewOk = await call('/uploads/previews/hardD.mp4', { token: prevD.body.playToken });
  assert.strictEqual(previewOk.status, 200);
  ok('the preview clip itself is protected and token-scoped');

  const crossPreview = await call('/uploads/previews/hardD.mp4', { token: tokA.body.playToken });
  assert.strictEqual(crossPreview.status, 403);
  ok('another title\'s token cannot fetch this preview');

  const remotePreview = await call('/api/player/token', {
    method: 'POST', token: user1, body: { videoId: 'hardE', isPreview: true }
  });
  assert.strictEqual(remotePreview.status, 503);
  assert.strictEqual(remotePreview.body.previewUnavailable, true);
  ok('a title without local media refuses a preview instead of streaming the film');

  /* ------------------------------------------------------- reconciliation */
  console.log('\n▸ Bank-credit reconciliation');
  const ord2 = await call('/api/pay/orders', { method: 'POST', token: user2, body: {} });
  assert.strictEqual(ord2.body.order.status, 'AWAITING_PAYMENT');

  const statement = '20/10/2026  UPI/MUSKAAN LTD/412345678901  99.99';
  const rec = await call('/api/admin/payments/reconcile', {
    method: 'POST', token: owner, body: { text: statement }
  });
  assert.strictEqual(rec.status, 200);
  assert.strictEqual(rec.body.matched.length, 1, 'one credit should match');
  assert.strictEqual(rec.body.matched[0].orderId, ord2.body.order.id);

  const afterRec = await call(`/api/pay/orders/${ord2.body.order.id}`, { token: user2 });
  assert.strictEqual(afterRec.body.order.status, 'PAID');
  assert.strictEqual(afterRec.body.order.source, 'statement');
  assert.strictEqual(afterRec.body.hasPass, true);
  ok('a statement credit unlocks its order and records source=statement');

  const replayStatement = await call('/api/admin/payments/reconcile', {
    method: 'POST', token: owner, body: { text: statement }
  });
  assert.strictEqual(replayStatement.body.matched.length, 0);
  assert(replayStatement.body.unmatched.some((u) => u.reason === 'duplicate_utr'));
  ok('replaying the same statement cannot credit twice');

  const unitDb = {
    payments: [
      { id: 'x1', email: 'a@x', amountPaise: 9999, status: 'AWAITING_PAYMENT', createdAt: 0, claims: [], utr: null },
      { id: 'x2', email: 'b@x', amountPaise: 9999, status: 'AWAITING_PAYMENT', createdAt: 1, claims: [], utr: null }
    ]
  };
  const ambiguous = reconcile.reconcile(unitDb, '20/10/2026 UPI 412345678901 99.99', Date.now());
  assert.strictEqual(ambiguous.matched.length, 0);
  assert(ambiguous.unmatched.some((u) => u.reason === 'ambiguous'));
  ok('two open orders with the same amount are never auto-matched');

  const claimedDb = {
    payments: [
      { id: 'y1', email: 'c@x', amountPaise: 9999, status: 'AWAITING_REVIEW', createdAt: 0,
        claims: [{ utr: '555666777888', at: 1 }], utr: '555666777888' },
      { id: 'y2', email: 'd@x', amountPaise: 9999, status: 'AWAITING_PAYMENT', createdAt: 1, claims: [], utr: null }
    ]
  };
  const byClaim = reconcile.reconcile(claimedDb, '20/10/2026 UPI 555666777888 99.99', Date.now());
  assert.strictEqual(byClaim.matched.length, 1);
  assert.strictEqual(byClaim.matched[0].orderId, 'y1');
  ok('a credit whose UTR matches a submitted claim is attributed correctly');

  const parsed = reconcile.parseCredits('20/10/2026 CR UPI/ACME/999888777666 ₹99.99 12,345.00');
  assert(parsed.some((c) => c.amountPaise === 9999 && c.utr === '999888777666'));
  assert.strictEqual(reconcile.parseAmountToPaise('₹1,23,456.78'), 12345678);
  ok('statement parsing handles currency, thousands separators and UTRs');

  /* ------------------------------------------------------ PIN recovery CLI */
  console.log('\n▸ PIN recovery');
  const cliStore = path.join(os.tmpdir(), `cli-store-${process.pid}.json`);
  fs.copyFileSync(TMP_DB, cliStore);
  execFileSync(process.execPath, [path.join(__dirname, 'reset-pin.js'), '--yes'], {
    env: Object.assign({}, process.env, { STREAMCOS_DATA_FILE: cliStore, STREAMCOS_SETUP_CODE: 'NEWCODE' }),
    stdio: 'ignore'
  });
  const afterCli = JSON.parse(fs.readFileSync(cliStore, 'utf8'));
  assert.strictEqual(afterCli.ownerPinHash, undefined);
  assert(afterCli.ownerSetup && afterCli.ownerSetup.hash);
  ok('`reset-pin --yes` clears the PIN and mints a fresh setup code');
  try { fs.unlinkSync(cliStore); } catch (e) {}

  /* ------------------------------------------------------------ launcher */
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');
  assert(!/taskkill\s+\/F\s+\/IM/.test(launcher), 'must not kill every cloudflared.exe');
  assert(!/execSync\(`taskkill \/F \/PID \$\{pid\}`\);\s*\} catch\(e\)\{\}\s*\}\s*\}\s*\}\s*catch/.test(launcher));
  assert(/--force/.test(launcher));
  assert(/\.on\('error'/.test(launcher), 'cloudflared spawn must handle ENOENT');
  assert(/isPortFree/.test(launcher));
  ok('launcher never mass-kills processes and handles a missing cloudflared');

  console.log(`\nAll ${checks} hardening checks passed.`);
}

async function run() {
  await new Promise((resolve) => server.listen(PORT, resolve));
  try {
    await main();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const file of CREATED) { try { fs.unlinkSync(file); } catch (e) {} }
    for (const ext of ['', '.bak']) {
      try { fs.unlinkSync(TMP_DB + ext); } catch (e) {}
    }
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(TMP_DB) + '.corrupt-')) {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (e) {}
      }
    }
  }
}

run().catch((err) => {
  console.error('\n✖ Hardening tests FAILED');
  console.error(err);
  process.exitCode = 1;
});
