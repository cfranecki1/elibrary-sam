const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { notFound, forbidden, badRequest } = require('../errors');
const { logActivity } = require('../services/activity');
const router = express.Router();
/**
 * @openapi
 * /api/community/messages:
 *   get:
 *     tags: [Community]
 *     summary: E64 public room messages (single public room — no recipients, no DMs)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 100 } }]
 *     responses:
 *       '200': { description: OK (oldest first within the returned window), content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/CommunityMessage' } } } } }
 *       '400': { description: Bad limit, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   post:
 *     tags: [Community]
 *     summary: E65 post message
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string, minLength: 1, maxLength: 1000 }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/CommunityMessage' } } } }
 * /api/community/messages/{id}:
 *   delete:
 *     tags: [Community]
 *     summary: E65b delete message (own or admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '403': { description: Not your message, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: Message not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
function shape(d, m) { const u = d.prepare('SELECT id, name, username FROM users WHERE id=?').get(m.user_id); return { id: m.id, body: m.body, user: u ? { id: u.id, name: u.name, username: u.username } : null, createdAt: m.created_at }; }
router.get('/messages', requireAuth, (req, res) => {
  const d = db.get();
  let limit = Number(req.query.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest('Bad limit');
  limit = Math.min(limit, 100);
  const rows = d.prepare('SELECT * FROM community_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
  res.json(rows.map(m => shape(d, m)));
});
router.post('/messages', requireAuth, validate(z.object({ body: z.string().min(1).max(1000) })), (req, res) => {
  const d = db.get();
  const info = d.prepare('INSERT INTO community_messages (user_id, body, created_at) VALUES (?,?,?)').run(req.user.id, req.body.body, new Date().toISOString());
  res.status(201).json(shape(d, d.prepare('SELECT * FROM community_messages WHERE id=?').get(info.lastInsertRowid)));
});
router.delete('/messages/:id', requireAuth, (req, res) => {
  const d = db.get();
  const m = d.prepare('SELECT * FROM community_messages WHERE id=?').get(req.params.id);
  if (!m) throw notFound('Message not found');
  if (m.user_id !== req.user.id && req.user.role !== 'admin') throw forbidden('Not your message');
  d.prepare('DELETE FROM community_messages WHERE id=?').run(m.id);
  logActivity({ actorId: req.user.id, subjectId: m.user_id, eventType: 'message_deleted', entityType: 'community_message', entityId: m.id, summary: 'Community message deleted' });
  res.json({ ok: true });
});
module.exports = router;
