const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, conflict, ApiError } = require('../errors');
const { createNotification } = require('../services/notifications');
const { awardPoints } = require('../services/points');
const { logActivity } = require('../services/activity');
const router = express.Router();
function shape(d, r, withUsers) {
  const out = { id: r.id, title: r.title, author: r.author, reason: r.reason, status: r.status, adminNote: r.admin_note, createdAt: r.created_at, updatedAt: r.updated_at };
  if (withUsers) {
    const u = d.prepare('SELECT id, name, username FROM users WHERE id=?').get(r.user_id);
    out.user = u ? { id: u.id, name: u.name, username: u.username } : null;
    const rb = r.resolved_by ? d.prepare('SELECT id, name, username FROM users WHERE id=?').get(r.resolved_by) : null;
    out.resolvedByUser = rb ? { id: rb.id, name: rb.name, username: rb.username } : null;
  }
  return out;
}
/**
 * @openapi
 * /api/requests:
 *   get:
 *     tags: [Requests]
 *     summary: E45 my requests
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/BookRequest' } } } } }
 *   post:
 *     tags: [Requests]
 *     summary: E44 create book request
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, author]
 *             properties:
 *               title: { type: string, minLength: 1, maxLength: 200 }
 *               author: { type: string, minLength: 1, maxLength: 120 }
 *               reason: { type: string, maxLength: 1000 }
 *     responses:
 *       '201': { description: Created (status Pending), content: { application/json: { schema: { $ref: '#/components/schemas/BookRequest' } } } }
 *       '409': { description: 'Already in the library (code ALREADY_IN_LIBRARY, with bookId) or duplicate pending request (ALREADY_REQUESTED)', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/requests/{id}:
 *   delete:
 *     tags: [Requests]
 *     summary: E45c withdraw own pending request
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '404': { description: Request not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Only a Pending request can be withdrawn, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/admin/requests:
 *   get:
 *     tags: [Requests]
 *     summary: E45b admin request list
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [Pending, Resolved, Rejected] } }
 *       - { name: sort, in: query, schema: { type: string, enum: [newest, oldest] } }
 *     responses:
 *       '200': { description: OK (items include user and resolvedByUser), content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/BookRequest' } } } } }
 * /api/admin/requests/{id}/status:
 *   patch:
 *     tags: [Requests]
 *     summary: E46 set request status (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [Resolved, Rejected] }
 *               adminNote: { type: string, maxLength: 1000 }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/BookRequest' } } } }
 *       '404': { description: Request not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Request is not Pending, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/', requireAuth, validate(z.object({ title: z.string().min(1).max(200), author: z.string().min(1).max(120), reason: z.string().max(1000).optional() })), (req, res) => {
  const d = db.get(); const { title, author, reason } = req.body;
  const inLib = d.prepare('SELECT id FROM books WHERE title_lower=? AND author_lower=?').get(title.trim().toLowerCase(), author.trim().toLowerCase());
  if (inLib) throw new ApiError(409, 'ALREADY_IN_LIBRARY', 'This book is already in the library', { bookId: inLib.id });
  const dup = d.prepare("SELECT id FROM book_requests WHERE user_id=? AND lower(title)=? AND lower(author)=? AND status='Pending'").get(req.user.id, title.trim().toLowerCase(), author.trim().toLowerCase());
  if (dup) throw new ApiError(409, 'ALREADY_REQUESTED', 'You already have a pending request for this book');
  const ts = new Date().toISOString();
  const info = d.prepare('INSERT INTO book_requests (user_id, title, author, reason, status, created_at, updated_at) VALUES (?,?,?,?,?, ?,?)')
    .run(req.user.id, title.trim(), author.trim(), reason ?? null, 'Pending', ts, ts);
  const r = d.prepare('SELECT * FROM book_requests WHERE id=?').get(info.lastInsertRowid);
  createNotification({ role: 'admin' }, { type: 'request_created', title: 'New book request', body: `"${r.title}" by ${r.author} was requested.`, relatedType: 'book_request', relatedId: r.id });
  logActivity({ actorId: req.user.id, eventType: 'request_created', entityType: 'book_request', entityId: r.id, summary: `Book requested: "${r.title}"` });
  res.status(201).json(shape(d, r, false));
});
router.get('/', requireAuth, (req, res) => {
  const d = db.get();
  res.json(d.prepare('SELECT * FROM book_requests WHERE user_id=? ORDER BY created_at DESC, id DESC').all(req.user.id).map(r => shape(d, r, false)));
});
router.delete('/:id', requireAuth, (req, res) => {
  const d = db.get();
  const r = d.prepare('SELECT * FROM book_requests WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!r) throw notFound('Request not found');
  if (r.status !== 'Pending') throw conflict('Only a Pending request can be withdrawn');
  d.prepare('DELETE FROM book_requests WHERE id=?').run(r.id);
  res.json({ ok: true });
});
const adminRouter = express.Router();
adminRouter.get('/', requireAdmin, (req, res) => {
  const d = db.get();
  const { status, sort } = req.query;
  if (status !== undefined && !['Pending', 'Resolved', 'Rejected'].includes(status)) { const { badRequest } = require('../errors'); throw badRequest('Bad status filter'); }
  if (sort !== undefined && !['newest', 'oldest'].includes(sort)) { const { badRequest } = require('../errors'); throw badRequest('Bad sort'); }
  let rows = d.prepare('SELECT * FROM book_requests').all();
  if (status) rows = rows.filter(r => r.status === status);
  rows.sort((a, b) => (sort === 'oldest' ? a.id - b.id : b.id - a.id));
  res.json(rows.map(r => shape(d, r, true)));
});
adminRouter.patch('/:id/status', requireAdmin, validate(z.object({ status: z.enum(['Resolved', 'Rejected']), adminNote: z.string().max(1000).optional() })), (req, res) => {
  const d = db.get();
  const r = d.prepare('SELECT * FROM book_requests WHERE id=?').get(req.params.id);
  if (!r) throw notFound('Request not found');
  if (r.status !== 'Pending') throw conflict('Request is not Pending');
  d.prepare('UPDATE book_requests SET status=?, admin_note=?, resolved_by=?, updated_at=? WHERE id=?').run(req.body.status, req.body.adminNote ?? null, req.user.id, new Date().toISOString(), r.id);
  const fresh = d.prepare('SELECT * FROM book_requests WHERE id=?').get(r.id);
  createNotification({ userId: r.user_id }, { type: 'request_status', title: 'Book request updated', body: `Your request for "${r.title}" was ${req.body.status.toLowerCase()}.`, relatedType: 'book_request', relatedId: r.id });
  if (req.body.status === 'Resolved') awardPoints(r.user_id, 'request_resolved', { relatedType: 'book_request', relatedId: r.id });
  logActivity({ actorId: req.user.id, subjectId: r.user_id, eventType: 'request_status', entityType: 'book_request', entityId: r.id, summary: `Request "${r.title}" ${req.body.status.toLowerCase()}` });
  res.json(shape(d, fresh, true));
});
module.exports = { router, adminRouter };
