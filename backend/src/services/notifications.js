const db = require('../db');
function nowIso() { return new Date().toISOString(); }
function insert(userId, { type, title, body, relatedType = null, relatedId = null }) {
  db.get().prepare('INSERT INTO notifications (user_id, type, title, body, related_type, related_id, is_read, created_at) VALUES (?,?,?,?,?,?,0,?)')
    .run(userId, type, title, body, relatedType, relatedId, nowIso());
}
// The ONLY notification creation path (ARCHITECTURE §6, six triggers).
function createNotification(target, payload) {
  const d = db.get();
  if (target.userId) insert(target.userId, payload);
  else if (target.role === 'admin') { d.prepare("SELECT id FROM users WHERE role='admin' AND is_active=1").all().forEach(u => insert(u.id, payload)); }
  else if (target.allUsers) { d.prepare('SELECT id FROM users WHERE is_active=1').all().forEach(u => insert(u.id, payload)); }
  // Retro-review F-2.8: a typo'd target used to silently drop the
  // notification — loud in the log instead (this is the ONLY path).
  else console.error('[notifications] unmatched target', JSON.stringify(target));
}
module.exports = { createNotification };
