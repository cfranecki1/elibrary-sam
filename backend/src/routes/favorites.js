const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notFound } = require('../errors');
const { bookRow } = require('../mappers');
const router = express.Router();
/**
 * @openapi
 * /api/favorites:
 *   get:
 *     tags: [Favorites]
 *     summary: E30 list favorites
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: array, items: { type: object, properties: { favoriteId: { type: integer }, createdAt: { type: string, format: date-time }, book: { $ref: '#/components/schemas/Book' } } } } } } }
 * /api/favorites/{bookId}:
 *   post:
 *     tags: [Favorites]
 *     summary: E31 add favorite (idempotent)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: bookId, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '200': { description: Already favourited, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Favorites]
 *     summary: E32 remove favorite
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: bookId, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Not favourited, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (req, res) => {
  const d = db.get();
  const rows = d.prepare('SELECT f.id AS fid, f.created_at AS fcreated, b.*, g.name AS genre_name, c.name AS category_name FROM favorites f JOIN books b ON b.id=f.book_id JOIN genres g ON g.id=b.genre_id JOIN categories c ON c.id=b.category_id WHERE f.user_id=? ORDER BY f.created_at DESC, f.id DESC').all(req.user.id);
  res.json(rows.map(r => ({ favoriteId: r.fid, createdAt: r.fcreated, book: bookRow(d, r, req.user.id) })));
});
router.post('/:bookId', requireAuth, (req, res) => {
  const d = db.get();
  if (!d.prepare('SELECT id FROM books WHERE id=?').get(req.params.bookId)) throw notFound('Book not found');
  const existing = d.prepare('SELECT id FROM favorites WHERE user_id=? AND book_id=?').get(req.user.id, req.params.bookId);
  if (existing) return res.status(200).json({ ok: true });
  d.prepare('INSERT INTO favorites (user_id, book_id, created_at) VALUES (?,?,?)').run(req.user.id, req.params.bookId, new Date().toISOString());
  res.status(201).json({ ok: true });
});
router.delete('/:bookId', requireAuth, (req, res) => {
  const d = db.get();
  const existing = d.prepare('SELECT id FROM favorites WHERE user_id=? AND book_id=?').get(req.user.id, req.params.bookId);
  if (!existing) throw notFound('Not favourited');
  d.prepare('DELETE FROM favorites WHERE id=?').run(existing.id);
  res.json({ ok: true });
});
module.exports = router;
