const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, forbidden } = require('../errors');
const { awardPoints } = require('../services/points');
const { createNotification } = require('../services/notifications');
const { logActivity } = require('../services/activity');
const router = express.Router();
const now = () => new Date().toISOString();
function shape(d, r) { const u = d.prepare('SELECT id, name, username FROM users WHERE id=?').get(r.user_id); return { id: r.id, rating: r.rating, reviewText: r.review_text, user: u ? { id: u.id, name: u.name, username: u.username } : null, adminResponse: r.admin_response, adminResponseAt: r.admin_response_at, createdAt: r.created_at, updatedAt: r.updated_at }; }
/**
 * @openapi
 * /api/books/{id}/reviews:
 *   get:
 *     tags: [Reviews]
 *     summary: E40 list reviews + average + distribution
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer }, description: 'Book id' }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { average: { type: number, nullable: true }, count: { type: integer }, distribution: { type: array, items: { type: object, properties: { stars: { type: integer }, count: { type: integer } } } }, items: { type: array, items: { $ref: '#/components/schemas/Review' } } } } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   post:
 *     tags: [Reviews]
 *     summary: E41 create/update own review (upsert — one review per user per book)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer }, description: 'Book id' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               reviewText: { type: string, maxLength: 2000 }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Review' } } } }
 *       '200': { description: Updated (existing review edited; any admin response is cleared), content: { application/json: { schema: { $ref: '#/components/schemas/Review' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/reviews/{id}:
 *   delete:
 *     tags: [Reviews]
 *     summary: E42 delete review (own or admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '403': { description: Not your review, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: Review not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/reviews/{id}/response:
 *   post:
 *     tags: [Reviews]
 *     summary: E43 admin response to review
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [response]
 *             properties:
 *               response: { type: string, minLength: 1, maxLength: 2000 }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Review' } } } }
 *       '404': { description: Review not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/books/:id/reviews', requireAuth, (req, res) => {
  const d = db.get();
  const book = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!book) throw notFound('Book not found');
  const items = d.prepare('SELECT * FROM reviews WHERE book_id=? ORDER BY created_at DESC, id DESC').all(book.id);
  const agg = d.prepare('SELECT AVG(rating) AS a, COUNT(*) AS c FROM reviews WHERE book_id=?').get(book.id);
  const distRows = d.prepare('SELECT rating, COUNT(*) AS c FROM reviews WHERE book_id=? GROUP BY rating').all(book.id);
  const distribution = [1, 2, 3, 4, 5].map(stars => ({ stars, count: (distRows.find(r => r.rating === stars) || {}).c || 0 }));
  res.json({ average: agg.c ? Math.round(agg.a * 10) / 10 : null, count: agg.c, distribution, items: items.map(r => shape(d, r)) });
});
router.post('/books/:id/reviews', requireAuth, validate(z.object({ rating: z.number().int().min(1).max(5), reviewText: z.string().max(2000).optional() })), (req, res) => {
  const d = db.get();
  const book = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!book) throw notFound('Book not found');
  const existing = d.prepare('SELECT * FROM reviews WHERE book_id=? AND user_id=?').get(book.id, req.user.id);
  if (existing) {
    // Retro-review F-1.7: an edit invalidates any admin response — it was
    // written against the old rating/text and must not display against
    // content the admin never saw.
    d.prepare('UPDATE reviews SET rating=?, review_text=?, admin_response=NULL, admin_response_by=NULL, admin_response_at=NULL, updated_at=? WHERE id=?').run(req.body.rating, req.body.reviewText ?? '', now(), existing.id);
    return res.status(200).json(shape(d, d.prepare('SELECT * FROM reviews WHERE id=?').get(existing.id)));
  }
  const info = d.prepare('INSERT INTO reviews (book_id, user_id, rating, review_text, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(book.id, req.user.id, req.body.rating, req.body.reviewText ?? '', now(), now());
  awardPoints(req.user.id, 'review_written', { relatedType: 'book', relatedId: book.id });
  logActivity({ actorId: req.user.id, eventType: 'review_created', entityType: 'book', entityId: book.id, summary: `Review added for "${book.title}"` });
  res.status(201).json(shape(d, d.prepare('SELECT * FROM reviews WHERE id=?').get(info.lastInsertRowid)));
});
router.delete('/reviews/:id', requireAuth, (req, res) => {
  const d = db.get();
  const r = d.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
  if (!r) throw notFound('Review not found');
  if (r.user_id !== req.user.id && req.user.role !== 'admin') throw forbidden('Not your review');
  d.prepare('DELETE FROM reviews WHERE id=?').run(r.id);
  res.json({ ok: true });
});
router.post('/reviews/:id/response', requireAdmin, validate(z.object({ response: z.string().min(1).max(2000) })), (req, res) => {
  const d = db.get();
  const r = d.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
  if (!r) throw notFound('Review not found');
  d.prepare('UPDATE reviews SET admin_response=?, admin_response_by=?, admin_response_at=?, updated_at=? WHERE id=?').run(req.body.response, req.user.id, now(), now(), r.id);
  // Deep-link target is the BOOK's reviews page (UI_SPEC §20.1): the
  // payload therefore carries the book, not the review row — a review id
  // cannot produce a book route on the client (retro-review L1-03).
  createNotification({ userId: r.user_id }, { type: 'review_response', title: 'Admin responded to your review', body: 'An admin responded to one of your reviews.', relatedType: 'book', relatedId: r.book_id });
  res.json(shape(d, d.prepare('SELECT * FROM reviews WHERE id=?').get(r.id)));
});
module.exports = router;
