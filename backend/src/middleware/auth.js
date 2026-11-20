const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { unauthorized, forbidden } = require('../errors');
// JWT proves IDENTITY only (audit F-02): role and is_active are re-read
// from the DB on every request, so demote/suspend bite on the next request.
function loadUser(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer (.+)$/);
  if (!m) throw unauthorized();
  let payload;
  try { payload = jwt.verify(m[1], config.jwtSecret); } catch (e) { throw unauthorized('Invalid or expired token'); }
  const user = db.get().prepare('SELECT * FROM users WHERE id=?').get(Number(payload.sub));
  if (!user) throw unauthorized('Invalid token');
  if (!user.is_active) throw forbidden('Account suspended');
  return user;
}
function requireAuth(req, res, next) { try { req.user = loadUser(req); next(); } catch (e) { next(e); } }
function requireAdmin(req, res, next) { try { req.user = loadUser(req); if (req.user.role !== 'admin') throw forbidden('Admin access required'); next(); } catch (e) { next(e); } }
module.exports = { requireAuth, requireAdmin };
