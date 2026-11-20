const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { notFound, conflict } = require('../errors');
const router = express.Router();
const now = () => new Date().toISOString();
// DATA_MODEL §8A accumulation: accrue min(now - lastHeartbeat, 120 s).
function accrue(d, s, endIt) {
  const gapSec = Math.max(0, Math.floor((Date.now() - new Date(s.last_heartbeat_at).getTime()) / 1000));
  const add = Math.min(gapSec, 120);
  const duration = s.duration_seconds + add; const ts = now();
  d.prepare('UPDATE reading_sessions SET duration_seconds=?, last_heartbeat_at=?, ended_at=?, updated_at=? WHERE id=?')
    .run(duration, ts, endIt ? ts : s.ended_at, ts, s.id);
  return d.prepare('SELECT * FROM reading_sessions WHERE id=?').get(s.id);
}
/**
 * @openapi
 * /api/reading-sessions:
 *   post:
 *     tags: [ReadingSessions]
 *     summary: E29 open reading session (server-stamped; any open session is closed first)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookId]
 *             properties:
 *               bookId: { type: integer }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { type: object, properties: { id: { type: integer }, bookId: { type: integer }, startedAt: { type: string, format: date-time } } } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/reading-sessions/{id}:
 *   put:
 *     tags: [ReadingSessions]
 *     summary: E39 heartbeat/end session (accrual capped at 120 s per interval)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [state]
 *             properties:
 *               state: { type: string, enum: [heartbeat, ended] }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { id: { type: integer }, durationSeconds: { type: integer }, endedAt: { type: string, nullable: true, format: date-time } } } } } }
 *       '404': { description: Session not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Session already ended, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/', requireAuth, validate(z.object({ bookId: z.number().int() })), (req, res) => {
  const d = db.get();
  if (!d.prepare('SELECT id FROM books WHERE id=?').get(req.body.bookId)) throw notFound('Book not found');
  const open = d.prepare('SELECT * FROM reading_sessions WHERE user_id=? AND ended_at IS NULL').all(req.user.id);
  open.forEach(s => accrue(d, s, true));
  const ts = now();
  const info = d.prepare('INSERT INTO reading_sessions (user_id, book_id, started_at, last_heartbeat_at, ended_at, duration_seconds, created_at, updated_at) VALUES (?,?,?,?,NULL,0,?,?)')
    .run(req.user.id, req.body.bookId, ts, ts, ts, ts);
  const s = d.prepare('SELECT * FROM reading_sessions WHERE id=?').get(info.lastInsertRowid);
  res.status(201).json({ id: s.id, bookId: s.book_id, startedAt: s.started_at });
});
router.put('/:id', requireAuth, validate(z.object({ state: z.enum(['heartbeat', 'ended']) })), (req, res) => {
  const d = db.get();
  const s = d.prepare('SELECT * FROM reading_sessions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!s) throw notFound('Session not found');
  if (s.ended_at) throw conflict('Session already ended');
  const updated = accrue(d, s, req.body.state === 'ended');
  res.json({ id: updated.id, durationSeconds: updated.duration_seconds, endedAt: updated.ended_at });
});
module.exports = router;
