'use strict';

/**
 * StreamCos payments — a self-hosted, YouPI-PG-style UPI checkout.
 *
 * Design notes (see README "Payments" section):
 *  - Money is stored as integer paise. No floats ever touch a balance.
 *  - The QR is a FIXED merchant QR supplied by the owner. It is never
 *    regenerated and never re-encoded: exactly one PNG is served, and its
 *    SHA-256 is pinned in the payment config so a swapped file is detectable.
 *  - A checkout session (order) is created server-side and owned by the signed
 *    in account (email comes from the HMAC token, never from the request body).
 *  - The payer submits the 12-digit UPI UTR. Depending on `verification`:
 *        instant -> auto-confirm (trust-on-claim, guarded by format, dedupe,
 *                    attempt caps and expiry)
 *        manual  -> hold for the owner to approve/reject in Studio
 *  - An HMAC-SHA256 signed webhook (YouPI contract) can confirm any order
 *    asynchronously and is the authoritative path when observers are wired up.
 */

const crypto = require('crypto');

const STATUS = {
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
};

const OPEN_STATUSES = [STATUS.AWAITING_PAYMENT, STATUS.AWAITING_REVIEW];

const TTL_MS = 5 * 60 * 1000; // QR validity / pay window
const CLAIM_GRACE_MS = 10 * 60 * 1000; // late UTR submissions still accepted
const MAX_CLAIMS = 5;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

// The QR the owner supplied, decoded (jsQR, version 8):
// upi://pay?am=99.99&cu=INR&mc=5621&mode=19&pa=muskaanlimited379042.rzp@rxairtel
//         &tn=Payment%20To%20Muskaan%20Limited&tr=Tq9OXXUU2VmlTVqrv2
const DEFAULTS = {
  sku: 'pass',
  skuName: 'StreamCos All-Access Pass',
  vpa: 'muskaanlimited379042.rzp@rxairtel',
  payeeName: 'Muskaan Limited',
  amountPaise: 9999,
  currency: 'INR',
  merchantCategoryCode: '5621',
  mode: '19',
  tr: 'Tq9OXXUU2VmlTVqrv2',
  note: 'StreamCos All-Access Pass',
  qrImage: 'assets/youpi-qr.png',
  qrSha256: '39a5d83cd22237b9e4f2043bae988d486ea8e243e298ba5793ab324ae97681be',
  qrPayload:
    'upi://pay?am=99.99&cu=INR&mc=5621&mode=19&pa=muskaanlimited379042.rzp@rxairtel' +
    '&tn=Payment%20To%20Muskaan%20Limited&tr=Tq9OXXUU2VmlTVqrv2',
  // 'instant' = auto-unlock on a valid UTR (works with no extra infrastructure)
  // 'manual'  = owner approves each claim in Studio
  verification: 'instant',
  webhookSecret: null
};

function generateWebhookSecret() {
  return 'whsec_' + crypto.randomBytes(24).toString('hex');
}

// Fabricated defaults from the first prototype. They must never be mistaken for
// a real receiving account.
const PLACEHOLDER_VPAS = new Set(['streamcos@upi', 'youpi@upi', 'merchant@upi']);

function toPaise(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULTS.amountPaise;
  return Math.round(n * 100);
}

function formatAmount(paise) {
  return (Number(paise) / 100).toFixed(2);
}

/**
 * Brings a stored paymentConfig (including the legacy {upiId, merchantName,
 * qrImage} shape) up to the current schema. Mutates and returns the config.
 */
function normalizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};

  // Migrate the legacy shape, but never carry over the made-up placeholder VPA:
  // the real payee is whatever the merchant QR points at.
  if (!cfg.vpa && cfg.upiId) {
    const legacy = String(cfg.upiId).trim();
    if (legacy && !PLACEHOLDER_VPAS.has(legacy)) cfg.vpa = legacy;
  }
  if (!cfg.payeeName && cfg.merchantName) cfg.payeeName = String(cfg.merchantName).trim();

  cfg.vpa = (cfg.vpa || '').trim();
  if (!cfg.vpa || PLACEHOLDER_VPAS.has(cfg.vpa)) cfg.vpa = DEFAULTS.vpa;
  cfg.payeeName = (cfg.payeeName || DEFAULTS.payeeName).trim() || DEFAULTS.payeeName;
  cfg.sku = cfg.sku || DEFAULTS.sku;
  cfg.skuName = cfg.skuName || DEFAULTS.skuName;
  cfg.currency = cfg.currency || DEFAULTS.currency;
  cfg.merchantCategoryCode = cfg.merchantCategoryCode || DEFAULTS.merchantCategoryCode;
  cfg.mode = cfg.mode || DEFAULTS.mode;
  cfg.tr = cfg.tr || DEFAULTS.tr;
  cfg.note = cfg.note || DEFAULTS.note;
  cfg.qrImage = cfg.qrImage || DEFAULTS.qrImage;
  cfg.qrSha256 = cfg.qrSha256 || DEFAULTS.qrSha256;
  cfg.qrPayload = cfg.qrPayload || DEFAULTS.qrPayload;
  cfg.verification = cfg.verification === 'manual' ? 'manual' : 'instant';
  cfg.amountPaise = Number.isInteger(cfg.amountPaise) && cfg.amountPaise > 0
    ? cfg.amountPaise
    : toPaise(cfg.amount != null ? cfg.amount : DEFAULTS.amountPaise / 100);
  cfg.webhookSecret = cfg.webhookSecret || generateWebhookSecret();

  // Legacy fields kept so older clients keep working.
  cfg.upiId = cfg.vpa;
  cfg.merchantName = cfg.payeeName;
  return cfg;
}

/** Public, secret-free view of the config for the checkout UI. */
function publicConfig(cfg) {
  return {
    sku: cfg.sku,
    skuName: cfg.skuName,
    vpa: cfg.vpa,
    payeeName: cfg.payeeName,
    upiId: cfg.vpa,
    merchantName: cfg.payeeName,
    amountPaise: cfg.amountPaise,
    amount: formatAmount(cfg.amountPaise),
    currency: cfg.currency,
    qrImage: cfg.qrImage,
    qrSha256: cfg.qrSha256,
    tr: cfg.tr,
    verification: cfg.verification
  };
}

/** Payment-app deep links built from the same fixed parameters as the QR. */
function upiLinks(cfg) {
  const amount = formatAmount(cfg.amountPaise);
  const base =
    'pa=' + encodeURIComponent(cfg.vpa) +
    '&pn=' + encodeURIComponent(cfg.payeeName) +
    '&am=' + amount +
    '&cu=' + encodeURIComponent(cfg.currency) +
    '&tn=' + encodeURIComponent(cfg.note) +
    '&tr=' + encodeURIComponent(cfg.tr) +
    '&mc=' + encodeURIComponent(cfg.merchantCategoryCode);

  return {
    upi: 'upi://pay?' + base,
    gpay: 'tez://upi/pay?' + base,
    phonepe: 'phonepe://pay?' + base,
    paytm: 'paytmmp://pay?' + base,
    bhim: 'bhim://pay?' + base
  };
}

function newOrderId(now) {
  return 'SC-' + now.toString(36).toUpperCase() + '-' +
    crypto.randomBytes(3).toString('hex').toUpperCase();
}

function isExpired(order, now) {
  return Number(order.expiresAt) <= now;
}

/** Lazily flips overdue open orders to EXPIRED. */
function sweepExpired(db, now) {
  const orders = Array.isArray(db.payments) ? db.payments : [];
  let changed = 0;
  for (const order of orders) {
    if (OPEN_STATUSES.includes(order.status) && isExpired(order, now)) {
      order.status = STATUS.EXPIRED;
      order.expiredAt = now;
      changed += 1;
    }
  }
  return changed;
}

/**
 * Creates (or reuses) the single open order for an account.
 * Reusing is deliberate: one payer, one fixed-amount QR, no duplicate sessions
 * with identical amounts — the same invariant YouPI's FIFO slot enforces.
 */
function createOrder(db, email, cfg, now) {
  if (!Array.isArray(db.payments)) db.payments = [];
  sweepExpired(db, now);

  const existing = db.payments
    .filter(
      (o) =>
        o.email === email &&
        o.sku === cfg.sku &&
        o.status === STATUS.AWAITING_PAYMENT &&
        !isExpired(o, now)
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (existing) return { order: existing, reused: true };

  const order = {
    id: newOrderId(now),
    email,
    sku: cfg.sku,
    skuName: cfg.skuName,
    amountPaise: cfg.amountPaise,
    currency: cfg.currency,
    vpa: cfg.vpa,
    status: STATUS.AWAITING_PAYMENT,
    createdAt: now,
    expiresAt: now + TTL_MS,
    paidAt: null,
    utr: null,
    source: null,
    claims: [],
    note: null,
    ip: null
  };
  db.payments.push(order);
  return { order, reused: false };
}

function findOrder(db, id) {
  const orders = Array.isArray(db.payments) ? db.payments : [];
  return orders.find((o) => o.id === id) || null;
}

function utrInUse(db, utr, exceptOrderId) {
  const orders = Array.isArray(db.payments) ? db.payments : [];
  return orders.some(
    (o) =>
      o.utr === utr &&
      o.id !== exceptOrderId &&
      [STATUS.PAID, STATUS.AWAITING_REVIEW].includes(o.status)
  );
}

/**
 * Serialises an order for the owning client. The full UTR is masked so a
 * leaked session id / response does not expose another party's reference.
 */
function publicOrder(order, now) {
  if (!order) return null;
  const open = OPEN_STATUSES.includes(order.status);
  return {
    id: order.id,
    sku: order.sku,
    skuName: order.skuName,
    status: order.status,
    amountPaise: order.amountPaise,
    amount: formatAmount(order.amountPaise),
    currency: order.currency,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    secondsLeft: open ? Math.max(0, Math.round((order.expiresAt - now) / 1000)) : 0,
    paidAt: order.paidAt || null,
    utr: order.utr ? maskUtr(order.utr) : null,
    source: order.source || null,
    attempts: Array.isArray(order.claims) ? order.claims.length : 0,
    canClaim:
      open && now <= Number(order.expiresAt) + CLAIM_GRACE_MS,
    note: order.note || null
  };
}

function maskUtr(utr) {
  const s = String(utr || '');
  if (s.length < 6) return '******';
  return s.slice(0, 4) + '••••' + s.slice(-2);
}

function markPaid(db, order, { utr, source, now, note }) {
  order.status = STATUS.PAID;
  order.utr = utr || order.utr || null;
  order.paidAt = order.paidAt || now;
  order.source = source || order.source || 'utr';
  if (note) order.note = note;
  order.amountPaise = order.amountPaise;
  return order;
}

/**
 * Payer submits their UTR.
 * Returns { ok, code, order } — `code` is a stable machine-readable reason.
 */
function claimPayment(db, order, utrRaw, { now, ip, cfg }) {
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  if (order.status === STATUS.PAID) return { ok: true, code: 'ALREADY_PAID', order };
  if (order.status === STATUS.REJECTED) return { ok: false, code: 'REJECTED', order };
  if (order.status === STATUS.CANCELLED) return { ok: false, code: 'CANCELLED', order };

  if (now > Number(order.expiresAt) + CLAIM_GRACE_MS) {
    if (order.status === STATUS.AWAITING_PAYMENT || order.status === STATUS.AWAITING_REVIEW) {
      order.status = STATUS.EXPIRED;
    }
    return { ok: false, code: 'EXPIRED', order };
  }

  const utr = String(utrRaw == null ? '' : utrRaw).replace(/\s+/g, '');
  if (!/^\d{12}$/.test(utr)) return { ok: false, code: 'BAD_UTR', order };

  if (!Array.isArray(order.claims)) order.claims = [];
  if (order.claims.length >= MAX_CLAIMS) return { ok: false, code: 'TOO_MANY_ATTEMPTS', order };
  if (order.claims.some((c) => c.utr === utr)) return { ok: false, code: 'DUPLICATE_CLAIM', order };
  if (utrInUse(db, utr, order.id)) return { ok: false, code: 'UTR_USED', order };

  order.claims.push({ utr, at: now, ip: ip || null });

  if (cfg.verification === 'manual') {
    order.status = STATUS.AWAITING_REVIEW;
    order.utr = utr;
    order.source = 'utr';
    return { ok: true, code: 'PENDING_REVIEW', order };
  }

  markPaid(db, order, { utr, source: 'utr', now });
  return { ok: true, code: 'PAID', order };
}

/** Owner decision on a held claim. */
function resolvePayment(db, order, action, { now, note }) {
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  if (order.status === STATUS.PAID && action === 'approve') {
    return { ok: true, code: 'ALREADY_PAID', order };
  }
  if (![STATUS.AWAITING_REVIEW, STATUS.AWAITING_PAYMENT, STATUS.EXPIRED].includes(order.status)) {
    return { ok: false, code: 'NOT_PENDING', order };
  }
  if (action === 'approve') {
    if (!order.utr) return { ok: false, code: 'NO_UTR', order };
    if (utrInUse(db, order.utr, order.id)) return { ok: false, code: 'UTR_USED', order };
    markPaid(db, order, { utr: order.utr, source: 'owner', now, note });
    return { ok: true, code: 'PAID', order };
  }
  order.status = STATUS.REJECTED;
  order.note = note || 'Rejected by owner';
  order.resolvedAt = now;
  return { ok: true, code: 'REJECTED', order };
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signWebhook(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * YouPI-compatible webhook:
 *   headers: X-Gateway-Signature: sha256=<hex>, X-Gateway-Timestamp, X-Gateway-Delivery-Id
 *   body:    { event:'SUCCESS', orderId, amount, amountPaise, utr, paymentId }
 *
 * Verification order matters: signature over the RAW bytes first, then
 * freshness, then replay, then payload/amount/order checks.
 */
function handleWebhook(db, rawBody, headers, cfg, now) {
  if (!Array.isArray(db.webhookDeliveries)) db.webhookDeliveries = [];

  const signature = String(headers['x-gateway-signature'] || '');
  const timestamp = Number(headers['x-gateway-timestamp'] || 0);
  const deliveryId = String(headers['x-gateway-delivery-id'] || '');

  const expected = signWebhook(cfg.webhookSecret, rawBody);
  if (!signature || !timingSafeEqualHex(signature, expected)) {
    return { ok: false, code: 'BAD_SIGNATURE', status: 401 };
  }
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_MS) {
    return { ok: false, code: 'STALE_TIMESTAMP', status: 401 };
  }
  if (deliveryId && db.webhookDeliveries.some((d) => d.id === deliveryId)) {
    return { ok: true, code: 'REPLAY_IGNORED', status: 200 };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch (err) {
    return { ok: false, code: 'BAD_JSON', status: 400 };
  }

  if (payload.event !== 'SUCCESS') {
    return { ok: true, code: 'IGNORED_EVENT', status: 200 };
  }

  const order = findOrder(db, payload.orderId);
  if (!order) return { ok: false, code: 'UNKNOWN_ORDER', status: 404 };

  // An amount is mandatory: a webhook that cannot state what was paid must not
  // be able to fulfil an order.
  let amountPaise = Number(payload.amountPaise);
  if (!Number.isInteger(amountPaise)) {
    const rupees = Number(payload.amount);
    amountPaise = Number.isFinite(rupees) ? Math.round(rupees * 100) : NaN;
  }
  if (!Number.isInteger(amountPaise)) {
    return { ok: false, code: 'MISSING_AMOUNT', status: 400 };
  }
  if (amountPaise !== order.amountPaise) {
    order.note = 'Webhook amount mismatch: ' + amountPaise + ' vs ' + order.amountPaise;
    return { ok: false, code: 'AMOUNT_MISMATCH', status: 409 };
  }
  if (payload.utr && utrInUse(db, String(payload.utr), order.id)) {
    return { ok: false, code: 'UTR_USED', status: 409 };
  }

  markPaid(db, order, {
    utr: payload.utr ? String(payload.utr) : null,
    source: 'webhook',
    now
  });
  order.gatewayPaymentId = payload.paymentId || null;

  if (deliveryId) db.webhookDeliveries.push({ id: deliveryId, at: now });
  db.webhookDeliveries = db.webhookDeliveries.filter((d) => now - d.at < DELIVERY_RETENTION_MS);

  return { ok: true, code: 'PAID', status: 200, order };
}

function paymentStats(db) {
  const orders = Array.isArray(db.payments) ? db.payments : [];
  const paid = orders.filter((o) => o.status === STATUS.PAID);
  return {
    total: orders.length,
    paid: paid.length,
    pendingReview: orders.filter((o) => o.status === STATUS.AWAITING_REVIEW).length,
    expired: orders.filter((o) => o.status === STATUS.EXPIRED).length,
    revenuePaise: paid.reduce((sum, o) => sum + Number(o.amountPaise || 0), 0)
  };
}

module.exports = {
  STATUS,
  OPEN_STATUSES,
  DEFAULTS,
  TTL_MS,
  CLAIM_GRACE_MS,
  MAX_CLAIMS,
  normalizeConfig,
  publicConfig,
  upiLinks,
  createOrder,
  findOrder,
  publicOrder,
  claimPayment,
  resolvePayment,
  handleWebhook,
  signWebhook,
  sweepExpired,
  paymentStats,
  formatAmount,
  toPaise,
  maskUtr
};
