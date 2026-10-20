'use strict';

/**
 * Owner credential helpers: the 4-digit studio PIN plus a first-run setup code.
 *
 * The setup code closes a real takeover hole: on a fresh install, anyone who
 * reached the studio could previously claim ownership by setting the first PIN.
 * Now the first-run code is printed in the server console (or supplied through
 * STREAMCOS_SETUP_CODE) and must be quoted back when creating the PIN.
 */

const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./auth');

// Crockford-ish base32, no vowels, so codes are unambiguous when read aloud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateSetupCode(groups = 2, size = 4) {
  const bytes = crypto.randomBytes(groups * size);
  const chars = [];
  for (let i = 0; i < bytes.length; i += 1) {
    chars.push(ALPHABET[bytes[i] % ALPHABET.length]);
  }
  const out = [];
  for (let g = 0; g < groups; g += 1) {
    out.push(chars.slice(g * size, (g + 1) * size).join(''));
  }
  return out.join('-');
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function createSetupRecord(code) {
  const plain = code || generateSetupCode();
  const { hash, salt } = hashPassword(normalizeCode(plain));
  return {
    record: { hash, salt, createdAt: Date.now() },
    code: plain
  };
}

function verifySetupCode(code, record) {
  if (!record || !record.hash || !record.salt) return false;
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  return verifyPassword(normalized, record.hash, record.salt);
}

module.exports = { generateSetupCode, createSetupRecord, verifySetupCode, normalizeCode };
