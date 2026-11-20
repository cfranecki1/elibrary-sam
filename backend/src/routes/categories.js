const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, conflict, badRequest } = require('../errors');
const router = express.Router();
const now = () => new Date().toISOString();
function catShape(d, c) { return { id: c.id, genreId: c.genre_id, genreName: (d.prepare('SELECT name FROM genres WHERE id=?').get(c.genre_id) || {}).name ?? null, name: c.name, description: c.description, bookCount: d.prepare('SELECT COUNT(*) AS c FROM books WHERE category_id=?').get(c.id).c }; }
/**
 * @openapi
 * /api/categories:
 *   get:
 *     tags: [Categories]
 *     summary: E15 list categories
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: genreId, in: query, schema: { type: integer }, description: 'Optional genre filter' }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Category' } } } } }
 *   post:
 *     tags: [Categories]
 *     summary: E16 create category (admin)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [genreId, name]
 *             properties:
 *               genreId: { type: integer }
 *               name: { type: string, minLength: 2, maxLength: 60 }
 *               description: { type: string, maxLength: 300 }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Category' } } } }
 *       '404': { description: Genre not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Duplicate category name within the genre, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/categories/{id}:
 *   put:
 *     tags: [Categories]
 *     summary: E17 update category (admin)
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
 *               name: { type: string, minLength: 2, maxLength: 60 }
 *               description: { type: string, maxLength: 300 }
 *               genreId: { type: integer, description: 'Move to another genre (only when the category has no books)' }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Category' } } } }
 *       '404': { description: Category or genre not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Duplicate name, or move blocked by books, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Categories]
 *     summary: E18 delete category (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Category not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Category still has books, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (req, res) => {
  const d = db.get(); let rows;
  if (req.query.genreId !== undefined) {
    const gid = Number(req.query.genreId);
    if (!Number.isInteger(gid)) throw badRequest('Bad genreId');
    rows = d.prepare('SELECT * FROM categories WHERE genre_id=? ORDER BY name').all(gid);
  } else rows = d.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(rows.map(c => catShape(d, c)));
});
router.post('/', requireAdmin, validate(z.object({ genreId: z.number().int(), name: z.string().min(2).max(60), description: z.string().max(300).optional() })), (req, res) => {
  const d = db.get();
  if (!d.prepare('SELECT id FROM genres WHERE id=?').get(req.body.genreId)) throw notFound('Genre not found');
  if (d.prepare('SELECT id FROM categories WHERE genre_id=? AND name_lower=?').get(req.body.genreId, req.body.name.trim().toLowerCase())) throw conflict('A category with this name already exists in this genre');
  const info = d.prepare('INSERT INTO categories (genre_id, name, name_lower, description, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(req.body.genreId, req.body.name.trim(), req.body.name.trim().toLowerCase(), req.body.description ?? null, now(), now());
  res.status(201).json(catShape(d, d.prepare('SELECT * FROM categories WHERE id=?').get(info.lastInsertRowid)));
});
router.put('/:id', requireAdmin, validate(z.object({ name: z.string().min(2).max(60).optional(), description: z.string().max(300).optional(), genreId: z.number().int().optional() }).refine(o => Object.keys(o).length >= 1, { error: 'At least one field is required' })), (req, res) => {
  const d = db.get(); const c = d.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
  if (!c) throw notFound('Category not found');
  const targetGenre = req.body.genreId ?? c.genre_id;
  if (req.body.genreId !== undefined && !d.prepare('SELECT id FROM genres WHERE id=?').get(req.body.genreId)) throw notFound('Genre not found');
  if (req.body.genreId !== undefined && req.body.genreId !== c.genre_id) {
    const books = d.prepare('SELECT COUNT(*) AS c FROM books WHERE category_id=?').get(c.id).c;
    if (books > 0) throw conflict('Cannot move a category that has books to another genre');
  }
  const newName = req.body.name?.trim() ?? c.name;
  if (d.prepare('SELECT id FROM categories WHERE genre_id=? AND name_lower=? AND id<>?').get(targetGenre, newName.toLowerCase(), c.id)) throw conflict('A category with this name already exists in this genre');
  d.prepare('UPDATE categories SET genre_id=?, name=?, name_lower=?, description=?, updated_at=? WHERE id=?')
    .run(targetGenre, newName, newName.toLowerCase(), req.body.description !== undefined ? req.body.description : c.description, now(), c.id);
  res.json(catShape(d, d.prepare('SELECT * FROM categories WHERE id=?').get(c.id)));
});
router.delete('/:id', requireAdmin, (req, res) => {
  const d = db.get(); const c = d.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
  if (!c) throw notFound('Category not found');
  if (d.prepare('SELECT COUNT(*) AS c FROM books WHERE category_id=?').get(c.id).c > 0) throw conflict('Category has books');
  d.prepare('DELETE FROM categories WHERE id=?').run(c.id);
  res.json({ ok: true });
});
module.exports = router;
