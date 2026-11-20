const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notFound } = require('../errors');
const { bookRow } = require('../mappers');
const { awardPoints } = require('../services/points');
const { logActivity } = require('../services/activity');
const router = express.Router();
/**
 * @openapi
 * /api/downloads:
 *   get:
 *     tags: [Downloads]
 *     summary: E33 list downloads
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: array, items: { type: object, properties: { downloadId: { type: integer }, downloadedAt: { type: string, format: date-time }, book: { $ref: '#/components/schemas/Book' } } } } } } }
 *   delete:
 *     tags: [Downloads]
 *     summary: E36 clear all downloads
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, removed: { type: integer } } } } } }
 * /api/downloads/{bookId}:
 *   post:
 *     tags: [Downloads]
 *     summary: E34 record download (idempotent; awards download points once per book)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: bookId, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '200': { description: Already recorded, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Downloads]
 *     summary: E35 delete download record
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: bookId, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Not downloaded, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (req, res) => {
  const d = db.get();
  const rows = d.prepare('SELECT dl.id AS did, dl.downloaded_at AS dlat, b.*, g.name AS genre_name, c.name AS category_name FROM downloads dl JOIN books b ON b.id=dl.book_id JOIN genres g ON g.id=b.genre_id JOIN categories c ON c.id=b.category_id WHERE dl.user_id=? ORDER BY dl.downloaded_at DESC, dl.id DESC').all(req.user.id);
  res.json(rows.map(r => ({ downloadId: r.did, downloadedAt: r.dlat, book: bookRow(d, r, req.user.id) })));
});
router.post('/:bookId', requireAuth, (req, res) => {
  const d = db.get();
  const book = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.bookId);
  if (!book) throw notFound('Book not found');
  const existing = d.prepare('SELECT id FROM downloads WHERE user_id=? AND book_id=?').get(req.user.id, book.id);
  if (existing) return res.status(200).json({ ok: true });
  d.prepare('INSERT INTO downloads (user_id, book_id, downloaded_at) VALUES (?,?,?)').run(req.user.id, book.id, new Date().toISOString());
  awardPoints(req.user.id, 'book_downloaded', { relatedType: 'book', relatedId: book.id });
  logActivity({ actorId: req.user.id, eventType: 'book_downloaded', entityType: 'book', entityId: book.id, summary: `"${book.title}" downloaded` });
  res.status(201).json({ ok: true });
});
router.delete('/:bookId', requireAuth, (req, res) => {
  const d = db.get();
  const existing = d.prepare('SELECT id FROM downloads WHERE user_id=? AND book_id=?').get(req.user.id, req.params.bookId);
  if (!existing) throw notFound('Not downloaded');
  d.prepare('DELETE FROM downloads WHERE id=?').run(existing.id);
  res.json({ ok: true });
});
router.delete('/', requireAuth, (req, res) => {
  const d = db.get();
  const info = d.prepare('DELETE FROM downloads WHERE user_id=?').run(req.user.id);
  res.json({ ok: true, removed: info.changes });
});
module.exports = router;
