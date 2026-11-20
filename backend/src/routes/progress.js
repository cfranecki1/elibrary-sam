const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { notFound, badRequest } = require('../errors');
const { bookRow, BOOK_SELECT } = require('../mappers');
const { awardPoints } = require('../services/points');
const { logActivity } = require('../services/activity');
const router = express.Router();
const now = () => new Date().toISOString();
/**
 * @openapi
 * /api/progress:
 *   get:
 *     tags: [Progress]
 *     summary: E37 list progress / history
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: state, in: query, schema: { type: string, enum: [all, in-progress, finished], default: all } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/ProgressRow' } } } } }
 *       '400': { description: Bad state filter, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   put:
 *     tags: [Progress]
 *     summary: E38 save progress (server-authoritative totals)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookId, currentPage, totalPages]
 *             properties:
 *               bookId: { type: integer }
 *               currentPage: { type: integer, minimum: 1 }
 *               totalPages: { type: integer, minimum: 1, description: 'Client-reported total; the server total (pdf_page_count, else pages) wins when known — a currentPage beyond the SERVER total is a 400' }
 *     responses:
 *       '200': { description: The saved progress row (percent recomputed server-side), content: { application/json: { schema: { $ref: '#/components/schemas/ProgressRow' } } } }
 *       '400': { description: currentPage exceeds the server total, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
function rowOut(d, p, userId) {
  const book = d.prepare(`${BOOK_SELECT} WHERE b.id=?`).get(p.book_id);
  const secs = d.prepare('SELECT COALESCE(SUM(duration_seconds),0) AS t FROM reading_sessions WHERE user_id=? AND book_id=?').get(userId, p.book_id).t;
  return { bookId: p.book_id, currentPage: p.current_page, totalPages: p.total_pages, percent: p.percent, lastReadAt: p.last_read_at, finishedAt: p.finished_at, readingSeconds: secs, book: bookRow(d, book, userId) };
}
router.get('/', requireAuth, (req, res) => {
  const d = db.get();
  let rows = d.prepare('SELECT * FROM reading_progress WHERE user_id=? ORDER BY last_read_at DESC').all(req.user.id);
  const state = req.query.state || 'all';
  if (!['all', 'in-progress', 'finished'].includes(state)) throw badRequest('Bad state filter');
  // Retro-review F-1.6: filter on the row's state, not the rounded
  // percent — page 1 of 443 rounds to 0% but is genuinely in progress.
  if (state === 'in-progress') rows = rows.filter(r => r.finished_at == null && r.current_page >= 1);
  if (state === 'finished') rows = rows.filter(r => r.finished_at != null);
  res.json(rows.map(r => rowOut(d, r, req.user.id)));
});
const putSchema = z.object({ bookId: z.number().int(), currentPage: z.number().int().min(1), totalPages: z.number().int().min(1) });
router.put('/', requireAuth, validate(putSchema), (req, res) => {
  const d = db.get(); const { bookId, currentPage } = req.body;
  const book = d.prepare('SELECT * FROM books WHERE id=?').get(bookId);
  if (!book) throw notFound('Book not found');
  // Retro-review F-1.4: the server is authoritative for the page count.
  // Trusting the client's totalPages let {currentPage:1, totalPages:1}
  // "finish" any book (50 pts + booksRead) without reading. The client's
  // value is used only when the book somehow has no server-side count.
  const totalPages = book.pdf_page_count || book.pages || req.body.totalPages;
  if (currentPage > totalPages) throw badRequest('currentPage exceeds totalPages');
  const percent = Math.round((100 * currentPage) / totalPages);
  const existing = d.prepare('SELECT * FROM reading_progress WHERE user_id=? AND book_id=?').get(req.user.id, bookId);
  const wasFinished = existing && existing.finished_at;
  const finishedAt = percent >= 100 ? (wasFinished || now()) : null;
  // Retro-review F-1.3: progress + activity + points commit together or
  // not at all (a late failure must not 500 after the progress write).
  d.transaction(() => {
    if (existing) d.prepare('UPDATE reading_progress SET current_page=?, total_pages=?, percent=?, last_read_at=?, finished_at=? WHERE id=?').run(currentPage, totalPages, percent, now(), finishedAt, existing.id);
    else d.prepare('INSERT INTO reading_progress (user_id, book_id, current_page, total_pages, percent, last_read_at, finished_at) VALUES (?,?,?,?,?,?,?)').run(req.user.id, bookId, currentPage, totalPages, percent, now(), finishedAt);
    const today = now().slice(0, 10);
    const opened = d.prepare("SELECT id FROM activity_log WHERE actor_user_id=? AND event_type='book_opened' AND entity_id=? AND substr(created_at,1,10)=?").get(req.user.id, bookId, today);
    if (!opened) logActivity({ actorId: req.user.id, eventType: 'book_opened', entityType: 'book', entityId: bookId, summary: `"${book.title}" opened` });
    awardPoints(req.user.id, 'daily_reading', {});
    if (percent >= 100 && !wasFinished) awardPoints(req.user.id, 'book_finished', { relatedType: 'book', relatedId: bookId });
  })();
  const row = d.prepare('SELECT * FROM reading_progress WHERE user_id=? AND book_id=?').get(req.user.id, bookId);
  res.json(rowOut(d, row, req.user.id));
});
module.exports = router;
