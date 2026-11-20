const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, conflict, badRequest } = require('../errors');
const router = express.Router();
const now = () => new Date().toISOString();
function shape(c) { return { id: c.id, bookId: c.book_id, chapterNumber: c.chapter_number, title: c.title, contentText: c.content_text, startPage: c.start_page, createdAt: c.created_at, updatedAt: c.updated_at }; }
/**
 * @openapi
 * /api/books/{id}/chapters:
 *   get:
 *     tags: [Chapters]
 *     summary: E25 list chapters
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer }, description: 'Book id' }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Chapter' } } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   post:
 *     tags: [Chapters]
 *     summary: E26 create chapter (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer }, description: 'Book id' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chapterNumber, title, contentText]
 *             properties:
 *               chapterNumber: { type: integer, minimum: 1 }
 *               title: { type: string, minLength: 1, maxLength: 200 }
 *               contentText: { type: string, maxLength: 20000 }
 *               startPage: { type: integer, minimum: 1, nullable: true, description: 'Must not exceed the book PDF page count' }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Chapter' } } } }
 *       '400': { description: startPage beyond the PDF page count, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Duplicate chapter title or number in this book, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/chapters/{id}:
 *   put:
 *     tags: [Chapters]
 *     summary: E27 update chapter (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               chapterNumber: { type: integer, minimum: 1 }
 *               title: { type: string, minLength: 1, maxLength: 200 }
 *               contentText: { type: string, maxLength: 20000 }
 *               startPage: { type: integer, minimum: 1, nullable: true }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Chapter' } } } }
 *       '404': { description: Chapter not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Duplicate chapter title or number, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Chapters]
 *     summary: E28 delete chapter (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Chapter not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/books/:id/chapters', requireAuth, (req, res) => {
  const d = db.get();
  if (!d.prepare('SELECT id FROM books WHERE id=?').get(req.params.id)) throw notFound('Book not found');
  res.json(d.prepare('SELECT * FROM chapters WHERE book_id=? ORDER BY chapter_number').all(req.params.id).map(shape));
});
const createSchema = z.object({ chapterNumber: z.number().int().positive(), title: z.string().min(1).max(200), contentText: z.string().max(20000), startPage: z.number().int().min(1).nullable().optional() });
router.post('/books/:id/chapters', requireAdmin, validate(createSchema), (req, res) => {
  const d = db.get();
  const book = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!book) throw notFound('Book not found');
  const b = req.body;
  if (b.startPage != null && book.pdf_page_count != null && b.startPage > book.pdf_page_count) throw badRequest('startPage exceeds the PDF page count');
  if (d.prepare('SELECT id FROM chapters WHERE book_id=? AND title_lower=?').get(book.id, b.title.trim().toLowerCase())) throw conflict('A chapter with this title already exists in this book');
  if (d.prepare('SELECT id FROM chapters WHERE book_id=? AND chapter_number=?').get(book.id, b.chapterNumber)) throw conflict('A chapter with this number already exists in this book');
  const info = d.prepare('INSERT INTO chapters (book_id, chapter_number, title, title_lower, content_text, start_page, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(book.id, b.chapterNumber, b.title.trim(), b.title.trim().toLowerCase(), b.contentText, b.startPage ?? null, now(), now());
  res.status(201).json(shape(d.prepare('SELECT * FROM chapters WHERE id=?').get(info.lastInsertRowid)));
});
const updateSchema = z.object({ chapterNumber: z.number().int().positive().optional(), title: z.string().min(1).max(200).optional(), contentText: z.string().max(20000).optional(), startPage: z.number().int().min(1).nullable().optional() }).refine(o => Object.keys(o).length >= 1, { error: 'At least one field is required' });
router.put('/chapters/:id', requireAdmin, validate(updateSchema), (req, res) => {
  const d = db.get();
  const c = d.prepare('SELECT * FROM chapters WHERE id=?').get(req.params.id);
  if (!c) throw notFound('Chapter not found');
  const b = req.body;
  const book = d.prepare('SELECT * FROM books WHERE id=?').get(c.book_id);
  if (b.startPage !== undefined && b.startPage != null && book.pdf_page_count != null && b.startPage > book.pdf_page_count) throw badRequest('startPage exceeds the PDF page count');
  const title = b.title?.trim() ?? c.title, num = b.chapterNumber ?? c.chapter_number;
  if (d.prepare('SELECT id FROM chapters WHERE book_id=? AND title_lower=? AND id<>?').get(c.book_id, title.toLowerCase(), c.id)) throw conflict('A chapter with this title already exists in this book');
  if (d.prepare('SELECT id FROM chapters WHERE book_id=? AND chapter_number=? AND id<>?').get(c.book_id, num, c.id)) throw conflict('A chapter with this number already exists in this book');
  d.prepare('UPDATE chapters SET chapter_number=?, title=?, title_lower=?, content_text=?, start_page=?, updated_at=? WHERE id=?')
    .run(num, title, title.toLowerCase(), b.contentText ?? c.content_text, b.startPage !== undefined ? b.startPage : c.start_page, now(), c.id);
  res.json(shape(d.prepare('SELECT * FROM chapters WHERE id=?').get(c.id)));
});
router.delete('/chapters/:id', requireAdmin, (req, res) => {
  const d = db.get();
  const c = d.prepare('SELECT * FROM chapters WHERE id=?').get(req.params.id);
  if (!c) throw notFound('Chapter not found');
  d.prepare('DELETE FROM chapters WHERE id=?').run(c.id);
  res.json({ ok: true });
});
module.exports = router;
