'use strict';

/**
 * Small dependency-free rate limiter.
 *
 * Fixed-window counters in memory, keyed by `<bucket>:<client>`. In-memory is
 * the right trade-off for a single-node self-hosted app: a restart clears
 * counters, which is acceptable, and it keeps the hot path synchronous.
 *
 * Each limiter can also enforce a global ceiling (across all clients), which
 * matters for expensive operations like scrypt password checks and the
 * 4-digit owner PIN.
 */

const CLEANUP_INTERVAL_MS = 60 * 1000;

class Limiter {
  constructor({ name, windowMs, max, globalMax = 0 }) {
    this.name = name;
    this.windowMs = windowMs;
    this.max = max;
    this.globalMax = globalMax;
    this.hits = new Map();
    this.global = { count: 0, resetAt: 0 };
    this.timer = setInterval(() => this.prune(), CLEANUP_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
    if (this.global.resetAt <= now) {
      this.global.count = 0;
      this.global.resetAt = 0;
    }
  }

  /** Counts one hit without rejecting (used after a successful action). */
  hit(key, now = Date.now()) {
    if (this.max <= 0 && this.globalMax <= 0) return;
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
    if (this.global.resetAt <= now) {
      this.global = { count: 1, resetAt: now + this.windowMs };
    } else {
      this.global.count += 1;
    }
  }

  /** Returns { allowed, retryAfterMs, remaining } without counting. */
  peek(key, now = Date.now()) {
    if (this.max <= 0 && this.globalMax <= 0) return { allowed: true, retryAfterMs: 0, remaining: Infinity };

    const entry = this.hits.get(key);
    const perClient = entry && entry.resetAt > now ? entry : null;
    const globalActive = this.global.resetAt > now ? this.global : null;

    let retryAfterMs = 0;
    let remaining = this.max > 0 ? this.max - (perClient ? perClient.count : 0) : Infinity;

    if (this.max > 0 && perClient && perClient.count >= this.max) {
      retryAfterMs = Math.max(retryAfterMs, perClient.resetAt - now);
    }
    if (this.globalMax > 0 && globalActive && globalActive.count >= this.globalMax) {
      retryAfterMs = Math.max(retryAfterMs, globalActive.resetAt - now);
      remaining = 0;
    }

    return {
      allowed: retryAfterMs === 0,
      retryAfterMs,
      remaining: this.max > 0 ? Math.max(0, remaining) : Infinity
    };
  }

  /** Checks and counts in one step. */
  take(key, now = Date.now()) {
    const verdict = this.peek(key, now);
    if (!verdict.allowed) return verdict;
    this.hit(key, now);
    return verdict;
  }

  reset(key) {
    if (key === undefined) { this.hits.clear(); this.global = { count: 0, resetAt: 0 }; return; }
    this.hits.delete(key);
  }
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Builds the limiter set. `STREAMCOS_RATE_LIMIT=off` disables all of them. */
function createLimiters() {
  const off = String(process.env.STREAMCOS_RATE_LIMIT || '').toLowerCase() === 'off';
  const windowScale = intEnv('STREAMCOS_RL_WINDOW_SCALE', 100) / 100;

  const make = (name, windowMs, max, globalMax) => new Limiter({
    name,
    windowMs: off ? 1 : Math.round(windowMs * windowScale) || windowMs,
    max: off ? 0 : intEnv(`STREAMCOS_RL_${name.toUpperCase()}_MAX`, max),
    globalMax: off ? 0 : intEnv(`STREAMCOS_RL_${name.toUpperCase()}_GLOBAL_MAX`, globalMax)
  });

  return {
    disabled: off,
    register: make('register', 60 * 60 * 1000, 5, 50),
    login: make('login', 15 * 60 * 1000, 10, 120),
    pin: make('pin', 15 * 60 * 1000, 5, 15),
    order: make('order', 10 * 60 * 1000, 30, 200),
    claim: make('claim', 10 * 60 * 1000, 20, 200),
    upload: make('upload', 60 * 60 * 1000, 20, 60),
    reconcile: make('reconcile', 10 * 60 * 1000, 10, 30),
    api: make('api', 60 * 1000, 300, 0)
  };
}

module.exports = { Limiter, createLimiters };
