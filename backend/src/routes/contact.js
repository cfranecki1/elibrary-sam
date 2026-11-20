const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, badRequest } = require('../errors');
const { createNotification } = require('../services/notifications');
const { logActivity } = require('../services/activity');
const router = express.Router();
const adminRouter = express.Router();
function shape(m) { return { id: m.id, name: m.name, email: m.email, subject: m.subject, message: m.message, status: m.status, createdAt: m.created_at }; }
/**
 * @openapi
 * /api/contact:
 *   post:
 *     tags: [Contact]
 *     summary: E66 send contact message (sender name/email come from the account)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subject, message]
 *             properties:
 *               subject: { type: string, minLength: 1, maxLength: 120 }
 *               message: { type: string, minLength: 1, maxLength: 2000 }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, id: { type: integer } } } } } }
 * /api/admin/contact-messages:
 *   get:
 *     tags: [Contact]
 *     summary: E67 admin contact list (pure GET — reading the list changes nothing)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: sort, in: query, schema: { type: string, enum: [newest, oldest] } }
 *       - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { items: { type: array, items: { $ref: '#/components/schemas/ContactMessage' } }, page: { type: integer }, limit: { type: integer }, total: { type: integer } } } } } }
 * /api/admin/contact-messages/{id}/read:
 *   post:
 *     tags: [Contact]
 *     summary: E67b mark contact message read (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/ContactMessage' } } } }
 *       '404': { description: Message not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/admin/contact-messages/{id}/reply:
 *   post:
 *     tags: [Contact]
 *     summary: E67c reply to contact message (admin) — delivered to the sender as a notification
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reply]
 *             properties:
 *               reply: { type: string, minLength: 1, maxLength: 2000 }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Message not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/', requireAuth, validate(z.object({ subject: z.string().min(1).max(120), message: z.string().min(1).max(2000) })), (req, res) => {
  const d = db.get();
  const info = d.prepare('INSERT INTO contact_messages (user_id, name, email, subject, message, status, created_at) VALUES (?,?,?,?,?, ?,?)')
    .run(req.user.id, req.user.name, req.user.email, req.body.subject, req.body.message, 'New', new Date().toISOString());
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});
adminRouter.get('/', requireAdmin, (req, res) => {
  const d = db.get();
  const { sort } = req.query;
  if (sort !== undefined && !['newest', 'oldest'].includes(sort)) throw badRequest('Bad sort');
  const page = Math.max(1, Number(req.query.page ?? 1) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
  let rows = d.prepare('SELECT * FROM contact_messages').all();
  rows.sort((a, b) => (sort === 'oldest' ? a.id - b.id : b.id - a.id));
  const total = rows.length;
  res.json({ items: rows.slice((page - 1) * limit, page * limit).map(shape), page, limit, total });
});
adminRouter.post('/:id/read', requireAdmin, (req, res) => {
  const d = db.get();
  const m = d.prepare('SELECT * FROM contact_messages WHERE id=?').get(req.params.id);
  if (!m) throw notFound('Message not found');
  d.prepare("UPDATE contact_messages SET status='Read' WHERE id=?").run(m.id);
  res.json(shape(d.prepare('SELECT * FROM contact_messages WHERE id=?').get(m.id)));
});
adminRouter.post('/:id/reply', requireAdmin, validate(z.object({ reply: z.string().min(1).max(2000) })), (req, res) => {
  const d = db.get();
  const m = d.prepare('SELECT * FROM contact_messages WHERE id=?').get(req.params.id);
  if (!m) throw notFound('Message not found');
  if (m.user_id) createNotification({ userId: m.user_id }, { type: 'contact_reply', title: 'Reply to your message', body: req.body.reply, relatedType: 'contact_message', relatedId: m.id });
  d.prepare("UPDATE contact_messages SET status='Read' WHERE id=?").run(m.id);
  logActivity({ actorId: req.user.id, subjectId: m.user_id, eventType: 'contact_replied', entityType: 'contact_message', entityId: m.id, summary: `Replied to contact message "${m.subject}"` });
  res.json({ ok: true });
});
module.exports = { router, adminRouter };
