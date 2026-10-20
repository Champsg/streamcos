'use strict';

/**
 * End-to-end payment tests for the YouPI-style UPI checkout.
 *
 * Run: node backend/test-payments.js
 *
 * The suite uses a throwaway data file (STREAMCOS_DATA_FILE) so it never
 * touches the real store, and it verifies the whole money path:
 *   QR asset identity → order creation → UTR claim → entitlement → playback,
 *   plus webhook HMAC auth, replay/tamper/amount defences, manual approval,
 *   expiry, attempt caps and duplicate-UTR protection.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `streamcos-pay-test-${process.pid}.json`);
process.env.STREAMCOS_DATA_FILE = TMP_DB;
process.env.STREAMCOS_RATE_LIMIT = 'off';
process.env.STREAMCOS_SETUP_CODE = 'TESTSETUP';

const server = require('./server');
const payments = require('./payments');

const PORT = Number(process.env.PAY_TEST_PORT || 5187);
const BASE = `http://127.0.0.1:${PORT}`;

let checks = 0;
function ok(label) {
  checks += 1;
  console.log(`  ✔ ${label}`);
}

async function call(pathname, { method = 'GET', token, body, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, res };
}

function sign(secret, raw) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

async function webhook(secret, payload, { signature, timestamp, deliveryId } = {}) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ts = timestamp || Date.now();
  const res = await fetch(BASE + '/api/youpi/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Signature': signature || sign(secret, raw),
      'X-Gateway-Timestamp': String(ts),
      'X-Gateway-Delivery-Id': deliveryId || crypto.randomUUID()
    },
    body: raw
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data };
}

async function register(name, email) {
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { name, email, pass: 'secret123' }
  });
  assert.strictEqual(res.status, 201, `register ${email}`);
  return res.body.token;
}

async function run() {
  await new Promise((resolve) => server.listen(PORT, resolve));

  /* ---------------------------------------------------------------- config */
  console.log('\n▸ Payment configuration & QR identity');
  const cfgRes = await call('/api/payment/config');
  assert.strictEqual(cfgRes.status, 200);
  const cfg = cfgRes.body.config;
  assert.strictEqual(cfg.vpa, 'muskaanlimited379042.rzp@rxairtel');
  assert.strictEqual(cfg.amountPaise, 9999);
  assert.strictEqual(cfg.amount, '99.99');
  assert.strictEqual(cfg.qrImage, 'assets/youpi-qr.png');
  assert.strictEqual(cfg.verification, 'instant');
  ok('config exposes the decoded VPA, ₹99.99 amount and fixed QR path');

  const links = cfgRes.body.links;
  assert(links.upi.startsWith('upi://pay?'), 'upi deep link');
  assert(links.upi.includes('pa=muskaanlimited379042.rzp%40rxairtel'));
  assert(links.upi.includes('am=99.99'));
  assert(links.upi.includes('mc=5621'));
  assert(links.upi.includes('cu=INR'));
  assert(links.gpay.startsWith('tez://upi/pay?'));
  assert(links.phonepe.startsWith('phonepe://pay?'));
  ok('UPI app deep links mirror the QR parameters exactly');

  const qrRes = await fetch(`${BASE}/assets/youpi-qr.png`);
  assert.strictEqual(qrRes.status, 200);
  const qrBytes = Buffer.from(await qrRes.arrayBuffer());
  const qrSha = crypto.createHash('sha256').update(qrBytes).digest('hex');
  assert.strictEqual(qrSha, cfg.qrSha256);
  assert.strictEqual(qrSha, '39a5d83cd22237b9e4f2043bae988d486ea8e243e298ba5793ab324ae97681be');
  assert(qrBytes.length > 5000);
  ok('served QR is byte-identical to the supplied merchant QR (SHA-256 pinned)');

  /* ---------------------------------------------------------------- orders */
  console.log('\n▸ Order lifecycle');
  const buyer1 = await register('Buyer One', 'buyer1@test.local');

  const unauth = await call('/api/pay/orders', { method: 'POST', body: { sku: 'pass' } });
  assert.strictEqual(unauth.status, 401);
  ok('unauthenticated order creation is rejected');

  const created = await call('/api/pay/orders', { method: 'POST', token: buyer1, body: { sku: 'pass' } });
  assert.strictEqual(created.status, 201);
  const order = created.body.order;
  assert.strictEqual(order.status, 'AWAITING_PAYMENT');
  assert.strictEqual(order.amount, '99.99');
  assert.strictEqual(order.amountPaise, 9999);
  assert(/^SC-[0-9A-Z]+-[0-9A-F]{6}$/.test(order.id), `order id shape: ${order.id}`);
  assert.strictEqual(order.expiresAt - order.createdAt, payments.TTL_MS);
  assert(order.secondsLeft > 290 && order.secondsLeft <= 300);
  ok(`server-authoritative order created (${order.id}, ₹${order.amount}, 5-min window)`);

  const again = await call('/api/pay/orders', { method: 'POST', token: buyer1, body: { sku: 'pass' } });
  assert.strictEqual(again.status, 201);
  assert.strictEqual(again.body.reused, true);
  assert.strictEqual(again.body.order.id, order.id);
  ok('a second request resumes the same open session (single-slot invariant)');

  const badUtr = await call(`/api/pay/orders/${order.id}/claim`, {
    method: 'POST', token: buyer1, body: { utr: '12345' }
  });
  assert.strictEqual(badUtr.status, 400);
  assert.strictEqual(badUtr.body.code, 'BAD_UTR');
  ok('malformed UTR is rejected before it can unlock anything');

  const UTR1 = '412345678901';
  const claim = await call(`/api/pay/orders/${order.id}/claim`, {
    method: 'POST', token: buyer1, body: { utr: UTR1 }
  });
  assert.strictEqual(claim.status, 200);
  assert.strictEqual(claim.body.code, 'PAID');
  assert.strictEqual(claim.body.order.status, 'PAID');
  assert.strictEqual(claim.body.hasPass, true);
  assert(!claim.body.order.utr.includes(UTR1), 'UTR must be masked in responses');
  ok('12-digit UTR confirms the payment and grants the pass');

  const userData = await call('/api/user/data', { token: buyer1 });
  assert.strictEqual(userData.body.hasPass, true);
  const play = await call('/api/player/token', { method: 'POST', token: buyer1, body: { videoId: 'sintel' } });
  assert.strictEqual(play.status, 200);
  assert(play.body.playToken);
  ok('entitlement is enforced by the playback gatekeeper');

  const replayClaim = await call(`/api/pay/orders/${order.id}/claim`, {
    method: 'POST', token: buyer1, body: { utr: UTR1 }
  });
  assert.strictEqual(replayClaim.status, 200);
  assert.strictEqual(replayClaim.body.code, 'ALREADY_PAID');
  ok('re-submitting the same UTR is idempotent');

  const buyer2 = await register('Buyer Two', 'buyer2@test.local');
  const order2 = (await call('/api/pay/orders', { method: 'POST', token: buyer2, body: {} })).body.order;
  const stolen = await call(`/api/pay/orders/${order2.id}/claim`, {
    method: 'POST', token: buyer2, body: { utr: UTR1 }
  });
  assert.strictEqual(stolen.status, 409);
  assert.strictEqual(stolen.body.code, 'UTR_USED');
  ok('a UTR already credited to another order cannot be reused');

  const UTR2 = '999888777666';
  const claim2 = await call(`/api/pay/orders/${order2.id}/claim`, {
    method: 'POST', token: buyer2, body: { utr: UTR2 }
  });
  assert.strictEqual(claim2.status, 200);
  assert.strictEqual(claim2.body.code, 'PAID');
  ok('a distinct UTR unlocks the second account');

  const legacy = await call('/api/purchase', { method: 'POST', token: buyer1, body: { videoId: 'pass', price: 1 } });
  assert.strictEqual(legacy.status, 410);
  ok('legacy client-trusted /api/purchase endpoint is retired');

  /* ---------------------------------------------------------------- owner */
  console.log('\n▸ Owner ledger & revenue');
  const pinSetup = await call('/api/admin/verify-pin', { method: 'POST', body: { pin: '1234' } });
  assert.strictEqual(pinSetup.body.needsSetup, true);

  const noCode = await call('/api/admin/verify-pin', { method: 'POST', body: { newPin: '1234' } });
  assert.strictEqual(noCode.status, 401);
  assert.match(noCode.body.error, /setup code/i);
  ok('first-run PIN requires the setup code (no anonymous takeover)');

  const pinSet = await call('/api/admin/verify-pin', {
    method: 'POST',
    body: { newPin: '1234', setupCode: 'TESTSETUP' }
  });
  assert(pinSet.body.ownerToken);
  assert.strictEqual(pinSet.body.setup, true);
  const owner = pinSet.body.ownerToken;
  ok('setup code + 4-digit PIN creates the owner session');

  const stats = await call('/api/admin/stats', { token: owner });
  assert.strictEqual(stats.body.salesCount, 2);
  assert.strictEqual(Math.round(stats.body.revenue * 100), 19998);
  ok('sale ledger records exactly two ₹99.99 payments (no duplicates)');

  const ledger = await call('/api/admin/payments', { token: owner });
  assert.strictEqual(ledger.status, 200);
  assert.strictEqual(ledger.body.stats.paid, 2);
  assert.strictEqual(ledger.body.stats.revenuePaise, 19998);
  assert(ledger.body.orders.every((o) => o.email));
  const secret = ledger.body.config.webhookSecret;
  assert(secret && secret.startsWith('whsec_'));
  assert.strictEqual(ledger.body.config.webhookPath, '/api/youpi/webhook');
  ok('owner sees the ledger, stats and webhook secret');

  const noOwner = await call('/api/admin/payments');
  assert.strictEqual(noOwner.status, 401);
  ok('ledger is owner-only');

  /* -------------------------------------------------------------- webhook */
  console.log('\n▸ YouPI webhook (HMAC-SHA256)');
  const buyer3 = await register('Buyer Three', 'buyer3@test.local');
  const order3 = (await call('/api/pay/orders', { method: 'POST', token: buyer3, body: {} })).body.order;
  const whPayload = {
    event: 'SUCCESS',
    orderId: order3.id,
    amount: '99.99',
    amountPaise: 9999,
    utr: '555666777888',
    paymentId: 'pay_webhook_1'
  };
  const delivery = 'delivery-1';

  const tampered = await webhook(secret, whPayload, { signature: 'sha256=' + 'ab'.repeat(32), deliveryId: 'delivery-bad' });
  assert.strictEqual(tampered.status, 401);
  assert.strictEqual(tampered.body.code, 'BAD_SIGNATURE');
  ok('unsigned / tampered webhook is rejected');

  const stale = await webhook(secret, whPayload, {
    timestamp: Date.now() - 10 * 60 * 1000,
    deliveryId: 'delivery-stale'
  });
  assert.strictEqual(stale.status, 401);
  assert.strictEqual(stale.body.code, 'STALE_TIMESTAMP');
  ok('replayed old timestamp is rejected (freshness window)');

  const accepted = await webhook(secret, whPayload, { deliveryId: delivery });
  assert.strictEqual(accepted.status, 200);
  assert.strictEqual(accepted.body.code, 'PAID');

  const polled3 = await call(`/api/pay/orders/${order3.id}`, { token: buyer3 });
  assert.strictEqual(polled3.body.order.status, 'PAID');
  assert.strictEqual(polled3.body.order.source, 'webhook');
  assert.strictEqual(polled3.body.hasPass, true);
  ok('valid webhook marks the order PAID and unlocks the account');

  const replay = await webhook(secret, whPayload, { deliveryId: delivery, timestamp: accepted.body.ts });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.code, 'REPLAY_IGNORED');
  ok('duplicate delivery id is acknowledged but ignored');

  const buyer4 = await register('Buyer Four', 'buyer4@test.local');
  const order4 = (await call('/api/pay/orders', { method: 'POST', token: buyer4, body: {} })).body.order;
  const mismatch = await webhook(secret, Object.assign({}, whPayload, { orderId: order4.id, amountPaise: 100, utr: '111222333444' }));
  assert.strictEqual(mismatch.status, 409);
  assert.strictEqual(mismatch.body.code, 'AMOUNT_MISMATCH');
  const stillOpen = await call(`/api/pay/orders/${order4.id}`, { token: buyer4 });
  assert.strictEqual(stillOpen.body.order.status, 'AWAITING_PAYMENT');
  ok('webhook amount mismatch is refused and the order stays unpaid');

  const noAmount = await webhook(secret, {
    event: 'SUCCESS', orderId: order4.id, utr: '111222333445', paymentId: 'pay_no_amount'
  });
  assert.strictEqual(noAmount.status, 400);
  assert.strictEqual(noAmount.body.code, 'MISSING_AMOUNT');
  ok('webhook that states no amount is refused');

  const unknown = await webhook(secret, Object.assign({}, whPayload, { orderId: 'SC-NOPE-000000' }));
  assert.strictEqual(unknown.status, 404);
  ok('webhook for an unknown order is refused');

  const ignored = await webhook(secret, Object.assign({}, whPayload, { event: 'PENDING' }));
  assert.strictEqual(ignored.status, 200);
  assert.strictEqual(ignored.body.code, 'IGNORED_EVENT');
  ok('non-SUCCESS events are acknowledged without side effects');

  /* ------------------------------------------------------------ manual mode */
  console.log('\n▸ Manual approval mode');
  const manual = await call('/api/admin/payment/config', {
    method: 'POST', token: owner, body: { verification: 'manual' }
  });
  assert.strictEqual(manual.status, 200);
  assert.strictEqual(manual.body.config.verification, 'manual');

  const buyer5 = await register('Buyer Five', 'buyer5@test.local');
  const order5 = (await call('/api/pay/orders', { method: 'POST', token: buyer5, body: {} })).body.order;
  const held = await call(`/api/pay/orders/${order5.id}/claim`, {
    method: 'POST', token: buyer5, body: { utr: '777888999000' }
  });
  assert.strictEqual(held.status, 200);
  assert.strictEqual(held.body.code, 'PENDING_REVIEW');
  assert.strictEqual(held.body.hasPass, false);
  const blocked = await call('/api/player/token', { method: 'POST', token: buyer5, body: { videoId: 'sintel' } });
  assert.strictEqual(blocked.status, 403);
  ok('manual mode holds the claim without unlocking playback');

  const pendingLedger = await call('/api/admin/payments', { token: owner });
  const pending = pendingLedger.body.orders.find((o) => o.status === 'AWAITING_REVIEW');
  assert(pending && pending.id === order5.id);
  assert.strictEqual(pendingLedger.body.stats.pendingReview, 1);

  const approved = await call(`/api/admin/payments/${order5.id}/resolve`, {
    method: 'POST', token: owner, body: { action: 'approve' }
  });
  assert.strictEqual(approved.status, 200);
  assert.strictEqual(approved.body.order.status, 'PAID');

  const buyer5Data = await call('/api/user/data', { token: buyer5 });
  assert.strictEqual(buyer5Data.body.hasPass, true);
  ok('owner approval releases the held payment and grants the pass');

  const restore = await call('/api/admin/payment/config', {
    method: 'POST', token: owner, body: { verification: 'instant' }
  });
  assert.strictEqual(restore.body.config.verification, 'instant');

  const badAmount = await call('/api/admin/payment/config', {
    method: 'POST', token: owner, body: { amount: 0 }
  });
  assert.strictEqual(badAmount.status, 400);
  const badVpa = await call('/api/admin/payment/config', {
    method: 'POST', token: owner, body: { vpa: 'not-a-vpa' }
  });
  assert.strictEqual(badVpa.status, 400);
  ok('owner config rejects invalid VPA and non-positive amounts');

  /* --------------------------------------------------- unit: clock & caps */
  console.log('\n▸ Expiry, grace and attempt caps (injected clock)');
  const unitCfg = payments.normalizeConfig(null);
  const t0 = 1_700_000_000_000;
  const db = { payments: [] };
  const unitOrder = payments.createOrder(db, 'unit@test.local', unitCfg, t0).order;

  const early = payments.claimPayment(db, unitOrder, '123123123123', {
    now: t0 + payments.TTL_MS + 1000, ip: null, cfg: unitCfg
  });
  assert.strictEqual(early.code, 'PAID', 'grace window still accepts a UTR');
  ok('a UTR submitted within the 10-minute grace window still confirms');

  const db2 = { payments: [] };
  const lateOrder = payments.createOrder(db2, 'unit2@test.local', unitCfg, t0).order;
  const late = payments.claimPayment(db2, lateOrder, '123123123123', {
    now: t0 + payments.TTL_MS + payments.CLAIM_GRACE_MS + 1e3, ip: null, cfg: unitCfg
  });
  assert.strictEqual(late.code, 'EXPIRED');
  assert.strictEqual(lateOrder.status, payments.STATUS.EXPIRED);
  ok('claims after the grace window expire the session');

  const manualCfg = Object.assign({}, unitCfg, { verification: 'manual' });
  const db3 = { payments: [] };
  const capOrder = payments.createOrder(db3, 'unit3@test.local', manualCfg, t0).order;
  const dup1 = payments.claimPayment(db3, capOrder, '400000000001', { now: t0 + 1000, ip: null, cfg: manualCfg });
  assert.strictEqual(dup1.code, 'PENDING_REVIEW');
  const dup2 = payments.claimPayment(db3, capOrder, '400000000001', { now: t0 + 2000, ip: null, cfg: manualCfg });
  assert.strictEqual(dup2.code, 'DUPLICATE_CLAIM');
  for (let i = 0; i < 4; i += 1) {
    payments.claimPayment(db3, capOrder, `40000000000${i + 2}`, { now: t0 + 3000 + i, ip: null, cfg: manualCfg });
  }
  const capped = payments.claimPayment(db3, capOrder, '499999999999', { now: t0 + 9000, ip: null, cfg: manualCfg });
  assert.strictEqual(capped.code, 'TOO_MANY_ATTEMPTS');
  ok(`duplicate claims are rejected and attempts are capped at ${payments.MAX_CLAIMS}`);

  assert.strictEqual(payments.maskUtr('412345678901'), '4123••••01');
  assert.strictEqual(payments.publicConfig(unitCfg).amount, '99.99');
  assert.strictEqual(payments.toPaise('99.99'), 9999);
  ok('money helpers use integer paise and mask UTRs');

  const migrated = payments.normalizeConfig({ upiId: 'streamcos@upi', merchantName: 'StreamCos Cinema', qrImage: null });
  assert.strictEqual(migrated.vpa, 'muskaanlimited379042.rzp@rxairtel');
  assert.strictEqual(migrated.amountPaise, 9999);
  assert.strictEqual(migrated.qrImage, 'assets/youpi-qr.png');
  const custom = payments.normalizeConfig({ upiId: 'studio@okhdfcbank', merchantName: 'My Studio' });
  assert.strictEqual(custom.vpa, 'studio@okhdfcbank');
  assert.strictEqual(custom.payeeName, 'My Studio');
  ok('legacy placeholder VPA is migrated to the QR payee, custom VPAs survive');

  const sweepDb = { payments: [] };
  const doomed = payments.createOrder(sweepDb, 'unit4@test.local', unitCfg, t0).order;
  const swept = payments.sweepExpired(sweepDb, t0 + payments.TTL_MS + 1);
  assert.strictEqual(swept, 1);
  assert.strictEqual(doomed.status, payments.STATUS.EXPIRED);
  ok('expired sessions are swept on load and on poll');

  console.log(`\nAll ${checks} payment checks passed.`);
}

run()
  .catch((err) => {
    console.error('\n✖ Payment tests FAILED');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { server.close(); } catch (e) {}
    try { fs.unlinkSync(TMP_DB); } catch (e) {}
  });
