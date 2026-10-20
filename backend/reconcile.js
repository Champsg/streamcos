'use strict';

/**
 * Bank-credit reconciliation.
 *
 * The core weakness of UTR-only verification is that the server never sees the
 * money: a ₹1 transfer produces a perfectly valid 12-digit UTR. Without a bank
 * API or YouPI's SMS/email observers, the only authoritative source a merchant
 * already has is their **statement**.
 *
 * This module parses a pasted/exported statement (CSV or plain text), extracts
 * credit lines (amount + optional UTR), and matches them against open orders.
 * That gives the owner a post-facto, evidence-backed confirmation path in
 * minutes, with no third-party integration.
 */

const { STATUS, OPEN_STATUSES } = require('./payments');

/** "1,23,456.78" / "99.99" / "₹ 99.99" -> paise (integer). */
function parseAmountToPaise(raw) {
  const cleaned = String(raw).replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// An amount must stand alone: not part of a date (20/10/2026), a reference
// number (412345678901) or a hyphenated token.
const AMOUNT_RE = /(?<![\d/.-])(?:₹|rs\.?|inr)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?![\d/.-])/gi;
const UTR_RE = /\b(\d{12})\b/g;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?/;

function parseDate(line) {
  const m = line.match(DATE_RE);
  if (!m) return null;
  const date = m[1];
  const time = m[2] || '00:00:00';
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) iso = `${date}T${time}`;
  else {
    const parts = date.split(/[/-]/);
    if (parts.length === 3) {
      let [d, mo, y] = parts;
      if (y.length === 2) y = '20' + y;
      iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${time}`;
    }
  }
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Extracts candidate credits. A statement line often carries both the credited
 * amount and a running balance, so one line can yield several candidates; the
 * matcher picks whichever equals an open order's amount.
 */
function parseCredits(text) {
  const lines = String(text || '').split(/\r?\n/);
  const credits = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 4) continue;
    if (/^(date|txn|transaction|narration|description|particulars|amount|utr|ref)\b/i.test(trimmed) &&
        !/\d{1,3}[.,]\d{2}/.test(trimmed)) {
      continue; // column header
    }

    const utrs = [...trimmed.matchAll(UTR_RE)].map((m) => m[1]);
    const amounts = [];
    for (const m of trimmed.matchAll(AMOUNT_RE)) {
      const digits = m[1].replace(/[,\s]/g, '');
      // 10+ digit integers are account/reference numbers, not money.
      if (digits.replace(/\.\d+$/, '').length > 9) continue;
      const paise = parseAmountToPaise(m[1]);
      if (paise && paise >= 100) amounts.push(paise);
    }
    if (!amounts.length) continue;
    // Keep at most the two most plausible values per line (credit + balance).
    const unique = [...new Set(amounts)].slice(0, 3);
    const at = parseDate(trimmed);

    for (const amountPaise of unique) {
      for (const utr of (utrs.length ? utrs : [null])) {
        credits.push({ amountPaise, utr, at, line: trimmed.slice(0, 200) });
      }
    }
  }

  return credits;
}

function markPaid(order, credit, now) {
  order.status = STATUS.PAID;
  order.utr = order.utr || credit.utr || null;
  order.paidAt = order.paidAt || now;
  order.source = 'statement';
  order.note = 'Matched to a bank credit dated ' + new Date(credit.at || now).toISOString();
  return order;
}

/**
 * Matches credits to open orders.
 * Returns { credits, matched, unmatched } where matched entries carry orderId.
 */
function reconcile(db, text, now = Date.now()) {
  const credits = parseCredits(text);
  const orders = Array.isArray(db.payments) ? db.payments : [];
  const claimed = new Set();
  const matched = [];
  const unmatched = [];

  // UTRs already credited to any paid order are duplicates, not new money.
  const usedUtrs = new Set(
    orders.filter((o) => o.status === STATUS.PAID && o.utr).map((o) => o.utr)
  );

  for (const credit of credits) {
    const candidates = orders.filter(
      (o) =>
        OPEN_STATUSES.includes(o.status) &&
        o.amountPaise === credit.amountPaise &&
        !claimed.has(o.id)
    );

    let target = null;

    if (credit.utr) {
      target = candidates.find((o) => o.utr === credit.utr) || null;
      if (!target) {
        target = candidates.find((o) =>
          Array.isArray(o.claims) && o.claims.some((c) => c.utr === credit.utr)
        ) || null;
      }
      if (!target && usedUtrs.has(credit.utr)) {
        unmatched.push({ ...credit, reason: 'duplicate_utr' });
        continue;
      }
    }

    if (!target && candidates.length === 1) target = candidates[0];

    if (!target && candidates.length > 1) {
      const review = candidates
        .filter((o) => o.status === STATUS.AWAITING_REVIEW)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (review.length === 1) target = review[0];
    }

    if (!target) {
      unmatched.push({
        ...credit,
        reason: candidates.length ? 'ambiguous' : 'no_matching_order'
      });
      continue;
    }

    markPaid(target, credit, now);
    if (target.utr) usedUtrs.add(target.utr);
    claimed.add(target.id);
    matched.push({
      orderId: target.id,
      email: target.email,
      amountPaise: target.amountPaise,
      utr: target.utr,
      line: credit.line
    });
  }

  return { credits: credits.length, matched, unmatched };
}

module.exports = { parseCredits, reconcile, parseAmountToPaise };
