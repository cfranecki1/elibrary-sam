// Defence-in-depth per-IP throttle on /api/auth/* (ARCH §5.3). Never the
// mechanism tests rely on; the DB lockout is the real control.
const hits = new Map();
function rateLimitAuth(req, res, next) {
  const now = Date.now(); const windowMs = 15 * 60 * 1000; const limit = 1000; // generous in v2 tests/dev
  const key = req.ip || 'unknown';
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (arr.length > limit) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
  next();
}
module.exports = { rateLimitAuth };
