const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, conflict } = require('../errors');
const router = express.Router();
const now = () => new Date().toISOString();
function genreShape(d, g) { const c = d.prepare('SELECT COUNT(*) AS c FROM books WHERE genre_id=?').get(g.id).c; return { id: g.id, name: g.name, description: g.description, sortOrder: g.sort_order, bookCount: c }; }
/**
 * @openapi
 * /api/genres:
 *   get:
 *     tags: [Genres]
 *     summary: E11 genres nested + categoryNames
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { genres: { type: array, items: { allOf: [{ $ref: '#/components/schemas/Genre' }, { type: object, properties: { categories: { type: array, items: { type: object, properties: { id: { type: integer }, name: { type: string }, description: { type: string, nullable: true }, bookCount: { type: integer } } } } } }] } }, categoryNames: { type: array, items: { type: string } } } } } } }
 *   post:
 *     tags: [Genres]
 *     summary: E12 create genre (admin)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 60 }
 *               description: { type: string, maxLength: 300 }
 *               sortOrder: { type: integer, minimum: 0 }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { $ref: '#/components/schemas/Genre' } } } }
 *       '409': { description: Duplicate genre name (case-insensitive), content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/genres/{id}:
 *   put:
 *     tags: [Genres]
 *     summary: E13 update genre (admin)
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
 *               sortOrder: { type: integer, minimum: 0 }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Genre' } } } }
 *       '404': { description: Genre not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Duplicate genre name, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Genres]
 *     summary: E14 delete genre (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Genre not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Genre still has categories or books, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (req, res) => {
  const d = db.get();
  const genres = d.prepare('SELECT * FROM genres ORDER BY sort_order, name').all().map(g => ({
    ...genreShape(d, g),
    categories: d.prepare('SELECT * FROM categories WHERE genre_id=? ORDER BY name').all(g.id).map(c => ({ id: c.id, name: c.name, description: c.description, bookCount: d.prepare('SELECT COUNT(*) AS c FROM books WHERE category_id=?').get(c.id).c })),
  }));
  const categoryNames = d.prepare('SELECT DISTINCT name FROM categories ORDER BY name').all().map(r => r.name);
  res.json({ genres, categoryNames });
});
const genreSchema = z.object({ name: z.string().min(2).max(60), description: z.string().max(300).optional(), sortOrder: z.number().int().min(0).optional() });
router.post('/', requireAdmin, validate(genreSchema), (req, res) => {
  const d = db.get();
  if (d.prepare('SELECT id FROM genres WHERE name_lower=?').get(req.body.name.trim().toLowerCase())) throw conflict('A genre with this name already exists');
  const info = d.prepare('INSERT INTO genres (name, name_lower, description, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(req.body.name.trim(), req.body.name.trim().toLowerCase(), req.body.description ?? null, req.body.sortOrder ?? 0, now(), now());
  res.status(201).json(genreShape(d, d.prepare('SELECT * FROM genres WHERE id=?').get(info.lastInsertRowid)));
});
router.put('/:id', requireAdmin, validate(genreSchema.partial().refine(o => Object.keys(o).length >= 1, { error: 'At least one field is required' })), (req, res) => {
  const d = db.get(); const g = d.prepare('SELECT * FROM genres WHERE id=?').get(req.params.id);
  if (!g) throw notFound('Genre not found');
  if (req.body.name && d.prepare('SELECT id FROM genres WHERE name_lower=? AND id<>?').get(req.body.name.trim().toLowerCase(), g.id)) throw conflict('A genre with this name already exists');
  d.prepare('UPDATE genres SET name=?, name_lower=?, description=?, sort_order=?, updated_at=? WHERE id=?')
    .run(req.body.name?.trim() ?? g.name, (req.body.name?.trim() ?? g.name).toLowerCase(), req.body.description !== undefined ? req.body.description : g.description, req.body.sortOrder ?? g.sort_order, now(), g.id);
  res.json(genreShape(d, d.prepare('SELECT * FROM genres WHERE id=?').get(g.id)));
});
router.delete('/:id', requireAdmin, (req, res) => {
  const d = db.get(); const g = d.prepare('SELECT * FROM genres WHERE id=?').get(req.params.id);
  if (!g) throw notFound('Genre not found');
  const deps = d.prepare('SELECT (SELECT COUNT(*) FROM categories WHERE genre_id=?) + (SELECT COUNT(*) FROM books WHERE genre_id=?) AS c').get(g.id, g.id).c;
  if (deps > 0) throw conflict('Genre has categories or books');
  d.prepare('DELETE FROM genres WHERE id=?').run(g.id);
  res.json({ ok: true });
});
module.exports = router;
