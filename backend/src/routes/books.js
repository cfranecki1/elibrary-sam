const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, conflict, badRequest, ApiError } = require('../errors');
const { bookRow, BOOK_SELECT } = require('../mappers');
const { extractPdf } = require('../services/pdfText');
const { createNotification } = require('../services/notifications');
const { logActivity } = require('../services/activity');
const router = express.Router();
const now = () => new Date().toISOString();
const PDF_MAX = 25 * 1024 * 1024, COVER_MAX = 5 * 1024 * 1024;
// F-A3 fix: the contract (API_CONTRACT §0/§10, E21) requires the DECLARED
// Content-Type to be checked in addition to magic bytes (previously the
// filter accepted everything and only magic bytes were verified). Declared
// types are allow-listed per field here; handlers additionally require the
// declared type to MATCH the magic-detected type for covers, so neither
// half of the check can be spoofed alone. `application/octet-stream` is
// NOT accepted as a wildcard: it is a non-declaration, and every in-scope
// client (Flutter/Dio, browsers, curl, Supertest) can send the real type.
const DECLARED_TYPES = { pdf: ['application/pdf'], cover: ['image/png', 'image/jpeg', 'image/webp'] };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PDF_MAX },
  fileFilter: (req, file, cb) => {
    const allowed = DECLARED_TYPES[file.fieldname];
    const declared = (file.mimetype || '').toLowerCase();
    if (allowed && !allowed.includes(declared)) {
      return cb(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Declared content type '${file.mimetype}' is not allowed for the '${file.fieldname}' file (allowed: ${allowed.join(', ')})`));
    }
    return cb(null, true);
  },
});
function assertDeclaredPdf(file) {
  if ((file.mimetype || '').toLowerCase() !== 'application/pdf') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'PDF uploads must be declared as application/pdf');
}
function resolveFile(name) {
  if (!name) return null;
  for (const dir of [config.uploadsDir, config.dataDir]) { const p = path.join(dir, name); if (fs.existsSync(p)) return p; }
  return null;
}
function isPdf(buf) { return buf && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-'; }
// F-A3 strengthening: magic bytes alone accepted a file that is just an
// image signature followed by junk (it was stored and served as a "cover").
// imageType now verifies minimal structural markers, dependency-free:
//  PNG  — full 8-byte signature, first chunk is a 13-byte IHDR starting
//         within the first 33 bytes, non-zero dimensions.
//  JPEG — SOI, a real second marker segment (APPn/quantisation/SOF/DQT…),
//         and the EOI marker as the final two bytes.
//  WebP — RIFF/WEBP header plus a VP8/VP8L/VP8X chunk descriptor.
function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    const marker = buf[3];
    const hasSecondSegment = buf[2] === 0xFF && marker >= 0xC0 && marker !== 0xD8 && marker !== 0xD9;
    const hasEoi = buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
    return hasSecondSegment && hasEoi ? { ext: '.jpg', mime: 'image/jpeg' } : null;
  }
  // PNG
  if (buf.length >= 33 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    const ihdrLen = buf.readUInt32BE(8);
    const ihdrType = buf.subarray(12, 16).toString('latin1');
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    return ihdrLen === 13 && ihdrType === 'IHDR' && width > 0 && height > 0 ? { ext: '.png', mime: 'image/png' } : null;
  }
  // WebP
  if (buf.length >= 20 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(buf.subarray(12, 16).toString('latin1'))) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}
// Shared cover validation for E21/E24d: size, structure (above), and the
// declared Content-Type must equal the detected type — a PNG declared as
// image/jpeg (or a PDF) is a 415, not a silent re-interpretation.
function validateCoverFile(file) {
  if (file.size > COVER_MAX) throw new ApiError(413, 'FILE_TOO_LARGE', 'Cover image too large');
  const t = imageType(file.buffer);
  if (!t) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Cover must be a valid JPG, PNG or WebP image');
  const declared = (file.mimetype || '').toLowerCase();
  if (declared !== t.mime) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Declared content type '${file.mimetype}' does not match the cover file contents (${t.mime})`);
  return t;
}
function saveFile(dir, name, buf) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), buf); }
function deleteFile(name) { const p = resolveFile(name); if (p) { try { fs.unlinkSync(p); } catch (_) {} } }
/**
 * @openapi
 * /api/books:
 *   get:
 *     tags: [Books]
 *     summary: E19 list/search books
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: search, in: query, schema: { type: string, maxLength: 120 } }
 *       - { name: field, in: query, schema: { type: string, enum: [all, title, author, genre] } }
 *       - { name: genreId, in: query, schema: { type: integer } }
 *       - { name: categoryId, in: query, schema: { type: integer } }
 *       - { name: genre, in: query, schema: { type: string }, description: 'Genre name (case-insensitive)' }
 *       - { name: sort, in: query, schema: { type: string, enum: [title, author, rating, newest, pages] } }
 *       - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { items: { type: array, items: { $ref: '#/components/schemas/Book' } }, page: { type: integer }, limit: { type: integer }, total: { type: integer } } } } } }
 *   post:
 *     tags: [Books]
 *     summary: E21 create book with optional PDF + cover (admin)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [title, author, publisher, publishedYear, pages, genreId, categoryId]
 *             properties:
 *               title: { type: string, maxLength: 200 }
 *               author: { type: string, maxLength: 120 }
 *               description: { type: string, maxLength: 5000 }
 *               publisher: { type: string, maxLength: 120 }
 *               publishedYear: { type: integer, minimum: 0, maximum: 2100 }
 *               pages: { type: integer, minimum: 1 }
 *               genreId: { type: integer }
 *               categoryId: { type: integer, description: 'Must belong to genreId' }
 *               pdf: { type: string, format: binary, description: 'Optional PDF (declared application/pdf, ≤25 MB); page count and text are extracted server-side' }
 *               cover: { type: string, format: binary, description: 'Optional cover image (JPG/PNG/WebP, ≤5 MB); declared type must match the file contents' }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Book' } } } }
 *       '400': { description: Validation failed, or category not in genre, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Duplicate (title, author), content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '413': { description: File too large, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '415': { description: Non-PDF PDF upload or invalid/mismatched cover, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '422': { description: PDF could not be parsed, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/books/{id}:
 *   get:
 *     tags: [Books]
 *     summary: E20 book detail + chapters
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { allOf: [{ $ref: '#/components/schemas/Book' }, { type: object, properties: { chapters: { type: array, items: { $ref: '#/components/schemas/ChapterRef' } } } }] } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   put:
 *     tags: [Books]
 *     summary: E22 update book metadata (admin)
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
 *               title: { type: string, maxLength: 200 }
 *               author: { type: string, maxLength: 120 }
 *               description: { type: string, maxLength: 5000 }
 *               publisher: { type: string, maxLength: 120 }
 *               publishedYear: { type: integer, minimum: 0, maximum: 2100 }
 *               pages: { type: integer, minimum: 1 }
 *               genreId: { type: integer }
 *               categoryId: { type: integer }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Book' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Duplicate (title, author), content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Books]
 *     summary: E23 delete book with confirm (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: integer } }
 *       - { name: confirm, in: query, required: true, schema: { type: string, enum: ['true'] } }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '400': { description: confirm=true missing, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/books/{id}/pdf:
 *   get:
 *     tags: [Books]
 *     summary: E24 stream PDF
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: integer } }
 *       - { name: download, in: query, schema: { type: string, enum: ['1'] }, description: '1 = attachment disposition, otherwise inline' }
 *     responses:
 *       '200': { description: PDF bytes, content: { application/pdf: { schema: { type: string, format: binary } } } }
 *       '404': { description: Book not found or no PDF on file, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   post:
 *     tags: [Books]
 *     summary: E24b replace PDF (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [pdf]
 *             properties:
 *               pdf: { type: string, format: binary }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Book' } } } }
 *       '400': { description: No pdf file supplied, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '415': { description: Not a PDF, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '422': { description: PDF could not be parsed, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/books/{id}/cover:
 *   get:
 *     tags: [Books]
 *     summary: E24c stream cover
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: Cover image bytes, content: { image/png: { schema: { type: string, format: binary } }, image/jpeg: { schema: { type: string, format: binary } }, image/webp: { schema: { type: string, format: binary } } } }
 *       '404': { description: Book not found or no cover on file, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   post:
 *     tags: [Books]
 *     summary: E24d replace cover (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [cover]
 *             properties:
 *               cover: { type: string, format: binary }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Book' } } } }
 *       '400': { description: No cover file supplied, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: Book not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '413': { description: Cover too large, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '415': { description: Invalid image or declared type mismatch, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
const listQuery = z.object({
  search: z.string().max(120).optional(),
  field: z.enum(['all', 'title', 'author', 'genre']).optional(),
  genreId: z.coerce.number().int().optional(),
  categoryId: z.coerce.number().int().optional(),
  genre: z.string().optional(),
  sort: z.enum(['title', 'author', 'rating', 'newest', 'pages']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
router.get('/', requireAuth, validate(listQuery, 'query'), (req, res) => {
  const d = db.get(); const q = req.validQuery;
  const page = q.page ?? 1, limit = q.limit ?? 20;
  let rows = d.prepare(`${BOOK_SELECT} ORDER BY b.id`).all();
  let books = rows.map(r => bookRow(d, r, req.user.id));
  if (q.genreId != null) books = books.filter(b => b.genreId === q.genreId);
  if (q.categoryId != null) books = books.filter(b => b.categoryId === q.categoryId);
  if (q.genre) books = books.filter(b => (b.genreName || '').toLowerCase() === q.genre.toLowerCase());
  if (q.search) {
    const s = q.search.toLowerCase(); const field = q.field || 'all';
    books = books.filter(b => {
      if (field === 'title') return b.title.toLowerCase().includes(s);
      if (field === 'author') return b.author.toLowerCase().includes(s);
      if (field === 'genre') return (b.genreName || '').toLowerCase().includes(s) || (b.categoryName || '').toLowerCase().includes(s);
      return b.title.toLowerCase().includes(s) || b.author.toLowerCase().includes(s) || (b.genreName || '').toLowerCase().includes(s) || (b.categoryName || '').toLowerCase().includes(s);
    });
  }
  const sort = q.sort || 'title';
  if (sort === 'title') books.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'author') books.sort((a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title));
  else if (sort === 'newest') books.sort((a, b) => b.id - a.id);
  else if (sort === 'pages') books.sort((a, b) => b.pages - a.pages);
  else if (sort === 'rating') books.sort((a, b) => ((b.rating ?? -1) - (a.rating ?? -1)) || (b.ratingCount - a.ratingCount));
  const total = books.length;
  res.json({ items: books.slice((page - 1) * limit, page * limit), page, limit, total });
});
router.get('/:id', requireAuth, (req, res) => {
  const d = db.get();
  const row = d.prepare(`${BOOK_SELECT} WHERE b.id=?`).get(req.params.id);
  if (!row) throw notFound('Book not found');
  const chapters = d.prepare('SELECT id, chapter_number, title, start_page FROM chapters WHERE book_id=? ORDER BY chapter_number').all(row.id)
    .map(c => ({ id: c.id, chapterNumber: c.chapter_number, title: c.title, startPage: c.start_page }));
  res.json({ ...bookRow(d, row, req.user.id), chapters });
});
const metaSchema = z.object({
  title: z.string().min(1).max(200), author: z.string().min(1).max(120),
  description: z.string().max(5000).optional(), publisher: z.string().max(120),
  publishedYear: z.coerce.number().int().min(0).max(2100), pages: z.coerce.number().int().positive(),
  genreId: z.coerce.number().int(), categoryId: z.coerce.number().int(),
});
async function prepareUploads(req) {
  const files = req.files || {};
  const pdfFile = files.pdf && files.pdf[0]; const coverFile = files.cover && files.cover[0];
  let pdf = null, cover = null;
  if (coverFile) {
    const t = validateCoverFile(coverFile);
    cover = { buffer: coverFile.buffer, originalName: coverFile.originalname, ...t };
  }
  if (pdfFile) {
    assertDeclaredPdf(pdfFile);
    if (!isPdf(pdfFile.buffer)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'File is not a PDF');
    const extracted = await extractPdf(pdfFile.buffer); // 422 on corrupt
    pdf = { buffer: pdfFile.buffer, originalName: pdfFile.originalname, pages: extracted.pages, text: extracted.text };
  }
  return { pdf, cover };
}
router.post('/', requireAdmin, upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  const parsed = metaSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('Validation failed', { details: parsed.error.issues.map(i => ({ field: i.path.join('.') || '(root)', message: i.message })) });
  const b = parsed.data; const d = db.get();
  const genre = d.prepare('SELECT * FROM genres WHERE id=?').get(b.genreId);
  const category = d.prepare('SELECT * FROM categories WHERE id=?').get(b.categoryId);
  if (!genre || !category) throw badRequest('Genre or category not found');
  if (category.genre_id !== genre.id) throw badRequest('Category does not belong to the genre');
  if (d.prepare('SELECT id FROM books WHERE title_lower=? AND author_lower=?').get(b.title.trim().toLowerCase(), b.author.trim().toLowerCase())) throw conflict('A book with this title and author already exists');
  const { pdf, cover } = await prepareUploads(req);
  const info = d.prepare(`INSERT INTO books (title, title_lower, author, author_lower, description, publisher, published_year, pages, genre_id, category_id, pdf_page_count, extracted_text, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.title.trim(), b.title.trim().toLowerCase(), b.author.trim(), b.author.trim().toLowerCase(), b.description ?? '', b.publisher, b.publishedYear, b.pages, b.genreId, b.categoryId, pdf ? pdf.pages : null, pdf ? pdf.text : null, req.user.id, now(), now());
  const bookId = info.lastInsertRowid;
  const sets = [], vals = [];
  if (pdf) { const name = `book-${bookId}-${crypto.randomBytes(4).toString('hex')}.pdf`; saveFile(config.uploadsDir, name, pdf.buffer); sets.push('pdf_file_name=?', 'pdf_original_name=?'); vals.push(name, pdf.originalName); }
  if (cover) { const name = `cover-${bookId}-${crypto.randomBytes(4).toString('hex')}${cover.ext}`; saveFile(config.uploadsDir, name, cover.buffer); sets.push('cover_file_name=?', 'cover_original_name=?'); vals.push(name, cover.originalName); }
  if (sets.length) { vals.push(bookId); d.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id=?`).run(...vals); }
  const row = d.prepare(`${BOOK_SELECT} WHERE b.id=?`).get(bookId);
  createNotification({ allUsers: true }, { type: 'new_book', title: 'New book added', body: `"${row.title}" by ${row.author} is now in the library.`, relatedType: 'book', relatedId: bookId });
  logActivity({ actorId: req.user.id, eventType: 'book_created', entityType: 'book', entityId: bookId, summary: `Book "${row.title}" added` });
  res.status(201).json(bookRow(d, row, req.user.id));
});
const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(), author: z.string().min(1).max(120).optional(),
  description: z.string().max(5000).optional(), publisher: z.string().max(120).optional(),
  publishedYear: z.number().int().min(0).max(2100).optional(), pages: z.number().int().positive().optional(),
  genreId: z.number().int().optional(), categoryId: z.number().int().optional(),
}).refine(o => Object.keys(o).length >= 1, { error: 'At least one field is required' });
router.put('/:id', requireAdmin, validate(updateSchema), (req, res) => {
  const d = db.get();
  const row = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!row) throw notFound('Book not found');
  const b = req.body;
  const genreId = b.genreId ?? row.genre_id, categoryId = b.categoryId ?? row.category_id;
  const category = d.prepare('SELECT * FROM categories WHERE id=?').get(categoryId);
  if (!d.prepare('SELECT id FROM genres WHERE id=?').get(genreId) || !category) throw badRequest('Genre or category not found');
  if (category.genre_id !== genreId) throw badRequest('Category does not belong to the genre');
  const title = b.title?.trim() ?? row.title, author = b.author?.trim() ?? row.author;
  if (d.prepare('SELECT id FROM books WHERE title_lower=? AND author_lower=? AND id<>?').get(title.toLowerCase(), author.toLowerCase(), row.id)) throw conflict('A book with this title and author already exists');
  d.prepare('UPDATE books SET title=?, title_lower=?, author=?, author_lower=?, description=?, publisher=?, published_year=?, pages=?, genre_id=?, category_id=?, updated_at=? WHERE id=?')
    .run(title, title.toLowerCase(), author, author.toLowerCase(), b.description ?? row.description, b.publisher ?? row.publisher, b.publishedYear ?? row.published_year, b.pages ?? row.pages, genreId, categoryId, now(), row.id);
  logActivity({ actorId: req.user.id, eventType: 'book_updated', entityType: 'book', entityId: row.id, summary: `Book "${title}" updated` });
  res.json(bookRow(d, d.prepare(`${BOOK_SELECT} WHERE b.id=?`).get(row.id), req.user.id));
});
router.delete('/:id', requireAdmin, (req, res) => {
  const d = db.get();
  if (req.query.confirm !== 'true') throw badRequest('confirm=true is required to delete a book');
  const row = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!row) throw notFound('Book not found');
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM favorites WHERE book_id=?').run(row.id);
    d.prepare('DELETE FROM downloads WHERE book_id=?').run(row.id);
    d.prepare('DELETE FROM reading_progress WHERE book_id=?').run(row.id);
    d.prepare('DELETE FROM reading_sessions WHERE book_id=?').run(row.id);
    d.prepare('DELETE FROM reviews WHERE book_id=?').run(row.id);
    d.prepare('DELETE FROM chapters WHERE book_id=?').run(row.id);
    d.prepare('DELETE FROM books WHERE id=?').run(row.id);
  });
  tx();
  deleteFile(row.pdf_file_name); deleteFile(row.cover_file_name);
  logActivity({ actorId: req.user.id, eventType: 'book_deleted', entityType: 'book', entityId: row.id, summary: `Book "${row.title}" deleted` });
  res.json({ ok: true });
});
router.get('/:id/pdf', requireAuth, (req, res) => {
  const d = db.get();
  const row = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!row) throw notFound('Book not found');
  const p = row.pdf_file_name && resolveFile(row.pdf_file_name);
  if (!p) throw notFound('No PDF on file for this book');
  const stat = fs.statSync(p);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(row.title)}.pdf"`);
  // Retro-review F-2.2: a read-stream error after the existence check
  // (file removed mid-request, unreadable) had NO listener — an
  // unhandled exception in the request path.
  const stream = fs.createReadStream(p);
  stream.on('error', err => { if (!res.headersSent) res.status(500).json({ error: 'Could not read the file', code: 'INTERNAL' }); else res.destroy(err); });
  stream.pipe(res);
});
router.post('/:id/pdf', requireAdmin, upload.fields([{ name: 'pdf', maxCount: 1 }]), async (req, res) => {
  const d = db.get();
  const row = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!row) throw notFound('Book not found');
  const file = req.files && req.files.pdf && req.files.pdf[0];
  if (!file) throw badRequest('A pdf file is required');
  assertDeclaredPdf(file);
  if (!isPdf(file.buffer)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'File is not a PDF');
  const extracted = await extractPdf(file.buffer);
  const name = `book-${row.id}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  saveFile(config.uploadsDir, name, file.buffer);
  const old = row.pdf_file_name;
  d.prepare('UPDATE books SET pdf_file_name=?, pdf_original_name=?, pdf_page_count=?, extracted_text=?, updated_at=? WHERE id=?').run(name, file.originalname, extracted.pages, extracted.text, now(), row.id);
  if (old && old !== name) deleteFile(old);
  res.json(bookRow(d, d.prepare(`${BOOK_SELECT} WHERE b.id=?`).get(row.id), req.user.id));
});
router.get('/:id/cover', requireAuth, (req, res) => {
  const d = db.get();
  const row = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!row) throw notFound('Book not found');
  const p = row.cover_file_name && resolveFile(row.cover_file_name);
  if (!p) throw notFound('No cover on file for this book');
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const stat = fs.statSync(p);
  res.setHeader('Content-Type', mime); res.setHeader('Content-Length', stat.size);
  // Retro-review F-2.2: a read-stream error after the existence check
  // (file removed mid-request, unreadable) had NO listener — an
  // unhandled exception in the request path.
  const stream = fs.createReadStream(p);
  stream.on('error', err => { if (!res.headersSent) res.status(500).json({ error: 'Could not read the file', code: 'INTERNAL' }); else res.destroy(err); });
  stream.pipe(res);
});
router.post('/:id/cover', requireAdmin, upload.fields([{ name: 'cover', maxCount: 1 }]), (req, res) => {
  const d = db.get();
  const row = d.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!row) throw notFound('Book not found');
  const file = req.files && req.files.cover && req.files.cover[0];
  if (!file) throw badRequest('A cover file is required');
  const t = validateCoverFile(file);
  const name = `cover-${row.id}-${crypto.randomBytes(4).toString('hex')}${t.ext}`;
  saveFile(config.uploadsDir, name, file.buffer);
  const old = row.cover_file_name;
  d.prepare('UPDATE books SET cover_file_name=?, cover_original_name=?, updated_at=? WHERE id=?').run(name, file.originalname, now(), row.id);
  if (old && old !== name) deleteFile(old);
  res.json(bookRow(d, d.prepare(`${BOOK_SELECT} WHERE b.id=?`).get(row.id), req.user.id));
});
module.exports = router;
