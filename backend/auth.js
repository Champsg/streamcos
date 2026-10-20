const crypto = require('crypto');

// shortcut: HMAC-SHA256 tokens instead of full RS256 JWT, zero dependency and tamper-proof.

function getSecret(existingSecret) {
  if (existingSecret && existingSecret.length >= 32) return existingSecret;
  return crypto.randomBytes(32).toString('hex');
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 32).toString('hex');
  return { hash: h, salt: s };
}

function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  try {
    const computed = crypto.scryptSync(String(password), salt, 32).toString('hex');
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function createToken(payload, secret, expiresInSeconds = 7 * 86400) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const data = Object.assign({}, payload, { exp });
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function extractToken(req, searchParams) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-token']) return req.headers['x-token'];
  if (searchParams && searchParams.get('token')) return searchParams.get('token');
  return null;
}

module.exports = {
  getSecret,
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  extractToken
};
