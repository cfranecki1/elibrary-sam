const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAdmin } = require('../middleware/auth');
const { notFound, conflict, badRequest } = require('../errors');
const { publicUser } = require('../mappers');
const { totalPoints } = require('../services/points');
const { logActivity } = require('../services/activity');
const router = express.Router();
/**
 * @openapi
 * /api/admin/stats:
 *   get:
 *     tags: [Admin]
 *     summary: E57 admin stats (real aggregates)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { totalBooks: { type: integer }, totalUsers: { type: integer }, activeUsers: { type: integer, description: 'Users with a login in the last 30 days' }, totalDownloads: { type: integer }, totalReviews: { type: integer }, pendingRequests: { type: integer } } } } } }
 * /api/admin/analytics:
 *   get:
 *     tags: [Admin]
 *     summary: E58 analytics (a read = a book_opened activity event)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { readsThisWeek: { type: array, items: { type: object, properties: { day: { type: string }, count: { type: integer } } } }, topBooks: { type: array, items: { type: object, properties: { book: { $ref: '#/components/schemas/Book' }, reads: { type: integer }, rating: { type: number, nullable: true } } } }, totals: { type: object, properties: { reads: { type: integer }, downloads: { type: integer }, reviews: { type: integer } } } } } } } }
 * /api/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: E59 admin user list
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: search, in: query, schema: { type: string }, description: 'Matches name, email or username' }
 *       - { name: sort, in: query, schema: { type: string, enum: [newest, name, lastLogin] } }
 *       - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { items: { type: array, items: { $ref: '#/components/schemas/AdminUser' } }, page: { type: integer }, limit: { type: integer }, total: { type: integer } } } } } }
 *       '400': { description: Bad sort, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/admin/users/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: E60 admin user detail (includes recentActivity — actor OR subject, so role/status changes on the user appear)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { allOf: [{ $ref: '#/components/schemas/AdminUser' }, { type: object, properties: { termsAcceptedAt: { type: string, nullable: true, format: date-time }, recentActivity: { type: array, items: { $ref: '#/components/schemas/ActivityItem' } } } }] } } } }
 *       '404': { description: User not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/admin/users/{id}/role:
 *   patch:
 *     tags: [Admin]
 *     summary: E61 change role
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role: { type: string, enum: [user, admin] }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/AdminUser' } } } }
 *       '404': { description: User not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Demoting the last ACTIVE admin, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/admin/users/{id}/status:
 *   patch:
 *     tags: [Admin]
 *     summary: E62 suspend/reactivate
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isActive]
 *             properties:
 *               isActive: { type: boolean }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/AdminUser' } } } }
 *       '404': { description: User not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Suspending yourself, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/admin/activity:
 *   get:
 *     tags: [Admin]
 *     summary: E63 recent activity
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }]
 *     responses:
 *       '200': { description: OK (newest first), content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/ActivityItem' } } } } }
 *       '400': { description: Bad limit, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
const count = (d, sql, ...p) => d.prepare(sql).get(...p).c;
router.get('/stats', requireAdmin, (req, res) => {
  const d = db.get();
  const since = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
  res.json({
    totalBooks: count(d, 'SELECT COUNT(*) AS c FROM books'),
    totalUsers: count(d, 'SELECT COUNT(*) AS c FROM users'),
    activeUsers: count(d, 'SELECT COUNT(*) AS c FROM users WHERE last_login_at IS NOT NULL AND last_login_at >= ?', since),
    totalDownloads: count(d, 'SELECT COUNT(*) AS c FROM downloads'),
    totalReviews: count(d, 'SELECT COUNT(*) AS c FROM reviews'),
    pendingRequests: count(d, "SELECT COUNT(*) AS c FROM book_requests WHERE status='Pending'"),
  });
});
router.get('/analytics', requireAdmin, (req, res) => {
  const d = db.get();
  const events = d.prepare("SELECT * FROM activity_log WHERE event_type='book_opened'").all();
  // Current week Mon..Sun (local dates from ISO timestamps)
  const todayD = new Date(); const dow = (todayD.getDay() + 6) % 7; // Mon=0
  const monday = new Date(todayD); monday.setHours(0, 0, 0, 0); monday.setDate(todayD.getDate() - dow);
  const sundayEnd = new Date(monday); sundayEnd.setDate(monday.getDate() + 7);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const readsThisWeek = days.map((day, i) => {
    const dayStart = new Date(monday); dayStart.setDate(monday.getDate() + i);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayStart.getDate() + 1);
    return { day, count: events.filter(e => { const t = new Date(e.created_at); return t >= dayStart && t < dayEnd; }).length };
  });
  const byBook = new Map();
  events.forEach(e => { if (e.entity_id) byBook.set(e.entity_id, (byBook.get(e.entity_id) || 0) + 1); });
  const topBooks = [...byBook.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([bookId, reads]) => {
    const b = d.prepare('SELECT * FROM books WHERE id=?').get(bookId);
    const agg = d.prepare('SELECT AVG(rating) AS a, COUNT(*) AS c FROM reviews WHERE book_id=?').get(bookId);
    const { bookRow, BOOK_SELECT } = require('../mappers');
    const row = d.prepare(`${BOOK_SELECT} WHERE b.id=?`).get(bookId);
    return { book: row ? bookRow(d, row, null) : { id: bookId, title: b ? b.title : '(deleted)' }, reads, rating: agg.c ? Math.round(agg.a * 10) / 10 : null };
  });
  res.json({ readsThisWeek, topBooks, totals: { reads: events.length, downloads: count(d, 'SELECT COUNT(*) AS c FROM downloads'), reviews: count(d, 'SELECT COUNT(*) AS c FROM reviews') } });
});
function userItem(d, u) {
  return { ...publicUser(u), isActive: !!u.is_active, lastLoginAt: u.last_login_at, booksRead: count(d, 'SELECT COUNT(*) AS c FROM reading_progress WHERE user_id=? AND finished_at IS NOT NULL', u.id), points: totalPoints(u.id) };
}
router.get('/users', requireAdmin, (req, res) => {
  const d = db.get();
  const { search, sort } = req.query;
  if (sort !== undefined && !['newest', 'name', 'lastLogin'].includes(sort)) throw badRequest('Bad sort');
  const page = Math.max(1, Number(req.query.page ?? 1) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
  let users = d.prepare('SELECT * FROM users').all();
  if (search) { const s = String(search).toLowerCase(); users = users.filter(u => u.name.toLowerCase().includes(s) || u.email_lower.includes(s) || u.username_lower.includes(s)); }
  if (sort === 'name') users.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'lastLogin') users.sort((a, b) => String(b.last_login_at || '').localeCompare(String(a.last_login_at || '')));
  else users.sort((a, b) => b.id - a.id);
  const total = users.length;
  res.json({ items: users.slice((page - 1) * limit, page * limit).map(u => userItem(d, u)), page, limit, total });
});
function activityShape(d, a) { const actor = a.actor_user_id ? d.prepare('SELECT id, name FROM users WHERE id=?').get(a.actor_user_id) : null; return { id: a.id, eventType: a.event_type, summary: a.summary, actor: actor ? { id: actor.id, name: actor.name } : null, createdAt: a.created_at }; }
router.get('/users/:id', requireAdmin, (req, res) => {
  const d = db.get();
  const u = d.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) throw notFound('User not found');
  const recent = d.prepare('SELECT * FROM activity_log WHERE actor_user_id=? OR subject_user_id=? ORDER BY created_at DESC, id DESC LIMIT 20').all(u.id, u.id).map(a => activityShape(d, a));
  res.json({ ...userItem(d, u), termsAcceptedAt: u.terms_accepted_at, recentActivity: recent });
});
router.patch('/users/:id/role', requireAdmin, validate(z.object({ role: z.enum(['user', 'admin']) })), (req, res) => {
  const d = db.get();
  const u = d.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) throw notFound('User not found');
  // Last-admin guard (fix 2026-11-20): only an ACTIVE admin counts — an
  // inactive admin is not protecting the system, so demoting one must not
  // 409 just because a different admin is the sole active one.
  if (u.role === 'admin' && u.is_active && req.body.role === 'user') {
    const admins = count(d, "SELECT COUNT(*) AS c FROM users WHERE role='admin' AND is_active=1");
    if (admins <= 1) throw conflict('Cannot demote the last active admin');
  }
  d.prepare('UPDATE users SET role=?, updated_at=? WHERE id=?').run(req.body.role, new Date().toISOString(), u.id);
  if (u.role !== req.body.role) {
    logActivity({ actorId: req.user.id, subjectId: u.id, eventType: 'role_changed', entityType: 'user', entityId: u.id, summary: `${u.name}'s role changed from ${u.role} to ${req.body.role}` });
  }
  res.json(userItem(d, d.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
});
router.patch('/users/:id/status', requireAdmin, validate(z.object({ isActive: z.boolean() })), (req, res) => {
  const d = db.get();
  const u = d.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) throw notFound('User not found');
  if (!req.body.isActive && u.id === req.user.id) throw conflict('You cannot suspend yourself');
  d.prepare('UPDATE users SET is_active=?, updated_at=? WHERE id=?').run(req.body.isActive ? 1 : 0, new Date().toISOString(), u.id);
  if (!!u.is_active !== req.body.isActive) {
    logActivity({ actorId: req.user.id, subjectId: u.id, eventType: 'status_changed', entityType: 'user', entityId: u.id, summary: req.body.isActive ? `${u.name} was reactivated` : `${u.name} was suspended` });
  }
  res.json(userItem(d, d.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
});
router.get('/activity', requireAdmin, (req, res) => {
  const d = db.get();
  let limit = Number(req.query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest('Bad limit');
  limit = Math.min(limit, 100);
  res.json(d.prepare('SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map(a => activityShape(d, a)));
});
module.exports = router;
