# StreamCos — Video Streaming Platform

Separated Backend & Frontend architecture with **Hovod-inspired Direct Video Upload & Adaptive Bitrate HLS Transcoding**, plus a **self-hosted YouPI-style UPI checkout** for the All-Access Pass.

## Architecture

```
streamcos-source/
├── backend/
│   ├── server.js        # HTTP API, byte-range streaming, media authorization
│   ├── payments.js      # UPI checkout: orders, UTR claims, expiry, HMAC webhook
│   ├── reconcile.js     # Match bank-statement credits to open orders
│   ├── previews.js      # Server-rendered 45s preview clips (ffmpeg)
│   ├── store.js         # Atomic JSON persistence + crash recovery
│   ├── ratelimit.js     # Per-client / global request limits
│   ├── owner.js         # Owner PIN + first-run setup code
│   ├── reset-pin.js     # CLI: recover a forgotten studio PIN
│   ├── auth.js          # scrypt passwords + HMAC session tokens
│   ├── transcoder.js    # HLS ladder (720p/480p/360p + master playlist)
│   ├── data.json        # Store (catalogue, users, payments, sales)
│   ├── uploads/         # videos/, posters/, hls/, previews/
│   ├── test.js          # Backend security & streaming self-check
│   ├── test-payments.js # End-to-end payment suite
│   └── test-hardening.js# Preview, PIN, rate-limit, reconcile, store tests
├── frontend/
│   ├── index.html
│   ├── runtime-config.js# Backend origin (generated; empty = same origin)
│   ├── css/style.css
│   ├── js/app.js
│   └── assets/          # posters, icon, youpi-qr.png (the merchant QR)
├── scripts/
│   ├── set-api-base.js  # Point frontend + netlify.toml at a backend URL
│   └── ui-smoke.js      # Headless-browser checkout smoke test
├── start.js             # Launcher (backend + optional Cloudflare tunnel)
└── netlify.toml         # Generated redirects for the Netlify deployment
```

## Running the App

```bash
npm install          # no dependencies, but keeps npm metadata consistent
npm start            # backend on :5000 + Cloudflare quick tunnel
npm start -- --no-tunnel          # LAN / localhost only
npm start -- --port 8080          # different port
npm start -- --force              # replace whatever holds the port (named, single PID)
```

The launcher never kills unrelated processes: if the port is busy it prints the
owning process and exits unless `--force` is given. A missing `cloudflared`
degrades to LAN-only instead of crashing.

### Tests

```bash
npm test                # backend (14) + payments (33) + hardening (22)
npm run test:payments
npm run test:hardening
npm run test:ui <port> <cdp-port> [out-dir]   # headless Chrome checkout
```

All suites run against throwaway stores (`STREAMCOS_DATA_FILE`) and never touch
`backend/data.json`.

## Features

1. **Direct Video Upload from PC** — owner-only, streamed to disk, with a size cap.
2. **Adaptive Bitrate HLS (Hovod Engine)** — ffmpeg ladder to 720p/480p/360p with a master playlist.
3. **Adaptive Web Player** — hls.js with native HLS and byte-range MP4 fallback.
4. **Local Wi-Fi Streaming** — binds `0.0.0.0` and prints LAN URLs.
5. **UPI Payments (YouPI-style)** — one fixed merchant QR, server-side orders, UTR claims and a signed webhook.
6. **Bank-statement reconciliation** — paste statement lines to confirm credits and unlock orders in bulk.

---

## Payments

The checkout is modelled on [YouPI-PG](https://github.com/youpi-pg/YouPI-PG): a
self-hosted UPI gateway where money settles directly into the merchant's bank
account and StreamCos never holds funds.

### The QR is fixed, and it is the only QR

`frontend/assets/youpi-qr.png` is the merchant QR supplied by the owner. Every
checkout shows that exact file — nothing is generated at runtime. It decodes to:

```
upi://pay?am=99.99&cu=INR&mc=5621&mode=19
        &pa=muskaanlimited379042.rzp@rxairtel
        &tn=Payment%20To%20Muskaan%20Limited
        &tr=Tq9OXXUU2VmlTVqrv2
```

| Property | Value |
| --- | --- |
| Payee VPA | `muskaanlimited379042.rzp@rxairtel` |
| Amount | **₹99.99 (9999 paise)** |
| Merchant category | `5621` |
| QR SHA-256 | `39a5d83c…7681be` (pinned; `/assets/youpi-qr.png` must match) |

The same parameters are exposed as `upi://`, `tez://`, `phonepe://`, `paytmmp://`
deep links. Checkout always charges the QR's amount: the Studio form accepts a
price, but verification is tied to the QR, so changing it away from ₹99.99 is a
configuration error the ledger will expose, not a new price.

### Checkout flow

```
POST /api/pay/orders          → order AWAITING_PAYMENT, 5-minute window
   ↓  QR + deep links + countdown
customer pays ₹99.99 in their UPI app
   ↓
POST /api/pay/orders/:id/claim { utr }
   instant mode → PAID            manual mode → AWAITING_REVIEW
   ↓
polling (3s) / webhook / statement reconciliation → unlocked
```

Server rules: price comes from config (never the request), integer paise only,
one open session per account, UTRs are 12 digits, deduplicated per order and
globally unique, five attempts per session, 10-minute grace after expiry, and
fulfilment is idempotent per order id.

### Four ways a payment gets confirmed

| Path | Sees the money? | Latency | Use when |
| --- | --- | --- | --- |
| **Webhook** (`/api/youpi/webhook`) | Yes — signed by your observer/gateway | seconds | You run YouPI's SMS/Gmail observers |
| **Statement reconciliation** | Yes — your bank's own record | minutes | No API available (the common case) |
| **Owner approval** | Yes — you check the bank app | manual | Suspicious or large claims |
| **UTR claim (instant)** | **No** | instant | Convenience default |

The honest limitation: a UTR proves *a* transfer happened, not that it was
₹99.99 to you. A ₹1 payment also produces a valid 12-digit reference. That is
why reconciliation and the webhook exist — they are the paths that actually see
credits. Switch **Verification** to *Manual* in the Studio if you would rather
approve every claim.

### Reconciling a statement

Owner Studio → Payments → **Match bank credits**. Paste lines from your bank's
statement or CSV export:

```
20/10/2026  UPI/MUSKAAN LTD/412345678901  99.99
2026-10-20,UPI,412345678901,99.99,12345.00
```

Each credit is matched by amount, and by UTR when present, against open orders.
Matching is deliberately conservative: two open orders with the same amount are
reported as `ambiguous` and never auto-matched; a replayed statement cannot
credit the same order twice. Matched orders are marked `source = statement`.

### Webhook contract

```
POST /api/youpi/webhook
X-Gateway-Signature: sha256=<hex HMAC-SHA256 of the raw body>
X-Gateway-Timestamp: <epoch ms, ±5 min>
X-Gateway-Delivery-Id: <uuid, deduplicated for 24h>

{ "event": "SUCCESS", "orderId": "SC-…", "amount": "99.99",
  "amountPaise": 9999, "utr": "412345678901", "paymentId": "pay_…" }
```

`200` paid/ignored, `400` bad JSON or missing amount, `401` bad signature or
stale timestamp, `404` unknown order, `409` amount mismatch or UTR already used.
The secret is generated on first run, shown in Studio → Configure, and rotatable
there.

### Operating it safely

- UPI is irreversible: agree refunds and pay them back manually.
- Reconcile the ledger against your bank statement regularly; the ledger is the
  only record of who paid.
- Keep `backend/data.json` private — it holds the webhook secret and customer
  emails.
- `instant` mode is a convenience, not proof. Prefer statement reconciliation or
  the webhook for anything that matters.

### Owner Studio

**Configure** edits VPA, payee name, price and verification mode, replaces the
QR, and shows/rotates the webhook secret. **Ledger** lists sessions with status,
amount, masked UTR and source, and lets you approve/reject held claims or
reconcile a statement.

---

## Security & reliability

| Area | Behaviour |
| --- | --- |
| Store writes | Temp file + `fsync` + atomic rename; previous copy kept as `data.json.bak`; a corrupt file is quarantined (`*.corrupt-<ts>`) and the backup is loaded |
| Owner PIN | 4 digits, but **failures are rate limited** per client and globally; first-run setup requires a code printed in the console |
| PIN recovery | `npm run reset:pin -- --yes` (or `node backend/reset-pin.js --yes`) clears the PIN and prints a new setup code |
| Rate limits | register 5/h, login 10/15m, PIN 5/15m, orders 30/10m, claims 20/10m, uploads 20/h, reconcile 10/10m, plus a 300/min per-client API ceiling (`STREAMCOS_RATE_LIMIT=off` disables, `STREAMCOS_RL_*_MAX` tunes) |
| Previews | A preview is a **separate 45-second MP4** rendered by ffmpeg; preview tokens are rejected on full media, and titles without local media refuse previews rather than streaming the film |
| Media scope | A token is bound to one title and matched by exact path or directory prefix — `hls_1` cannot unlock `hls_10`, and no token opens another title's folder |
| Uploads | Owner-only, streamed with a size cap (`STREAMCOS_MAX_UPLOAD_BYTES`, default 4 GB), rate limited |
| Sessions | HMAC-SHA256 tokens, 7-day user / 12-hour owner lifetime |

### Deployment URL (no more hardcoded tunnel)

Cloudflare quick-tunnel hostnames change on every restart. The frontend now
resolves its backend in this order:

1. a URL saved in the in-app **PC Backend** dialog,
2. `window.STREAMCOS_CONFIG.apiBase` from `frontend/runtime-config.js`,
3. same origin (correct when the backend serves the page).

`start.js` writes the tunnel URL into both `runtime-config.js` and
`netlify.toml` when it discovers it, and prints a reminder to redeploy Netlify.
To set it by hand:

```bash
npm run config:url -- https://your-backend.example.com
npm run config:url -- --clear      # back to same-origin
```

For a deployment you do not want to redeploy on every restart, use a **named
Cloudflare tunnel with your own domain** (or ngrok's static domain) instead of
the `trycloudflare.com` quick tunnel.
