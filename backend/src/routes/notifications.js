const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { notFound } = require('../errors');
const router = express.Router();
/**
 * @openapi
 * /api/notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: E47 list notifications
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: unreadOnly, in: query, schema: { type: string, enum: ['true', 'false', '1', '0'] }, description: 'Strictly parsed — false/0 list everything, true/1 only unread; anything else is a 400' }
 *       - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       '200': { description: OK (newest first), content: { application/json: { schema: { type: object, properties: { items: { type: array, items: { $ref: '#/components/schemas/Notification' } }, page: { type: integer }, limit: { type: integer }, total: { type: integer } } } } } }
 *       '400': { description: Invalid query value, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/notifications/{id}/read:
 *   post:
 *     tags: [Notifications]
 *     summary: E48 mark one read
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Notification not found (or not owned by the caller), content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/notifications/read-all:
 *   post:
 *     tags: [Notifications]
 *     summary: E49 mark all read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, updated: { type: integer } } } } } }
 * /api/notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: E50 unread count
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { count: { type: integer } } } } } }
 */
// Strict boolean query parsing (fix 2026-11-20): z.coerce.boolean() maps
// ANY non-empty string — including "false" and "0" — to true, so
// ?unreadOnly=false returned only-unread. Accept exactly true/false/1/0
// (case-insensitive) and 400 on anything else.
const boolQuery = z.string().optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  ctx.addIssue({ code: 'custom', message: 'unreadOnly must be one of true/false/1/0' });
  return z.NEVER;
});
router.get('/', requireAuth, validate(z.object({ unreadOnly: boolQuery, page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), 'query'), (req, res) => {
  const d = db.get(); const q = req.validQuery; const page = q.page ?? 1, limit = q.limit ?? 20;
  let rows = d.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC, id DESC').all(req.user.id);
  if (q.unreadOnly) rows = rows.filter(r => !r.is_read);
  const total = rows.length;
  const items = rows.slice((page - 1) * limit, page * limit).map(r => ({ id: r.id, type: r.type, title: r.title, body: r.body, relatedType: r.related_type, relatedId: r.related_id, isRead: !!r.is_read, createdAt: r.created_at }));
  res.json({ items, page, limit, total });
});
router.post('/read-all', requireAuth, (req, res) => {
  const info = db.get().prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0').run(req.user.id);
  res.json({ ok: true, updated: info.changes });
});
router.get('/unread-count', requireAuth, (req, res) => {
  const c = db.get().prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).c;
  res.json({ count: c });
});
router.post('/:id/read', requireAuth, (req, res) => {
  const d = db.get();
  const n = d.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!n) throw notFound('Notification not found'); // 404 for non-owned by design (F-15)
  d.prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(n.id);
  res.json({ ok: true });
});
module.exports = router;
