const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notFound, badRequest } = require('../errors');
const aiClient = require('../services/aiClient');
const router = express.Router();       // mounted at /api/ai
const settingsRouter = express.Router(); // mounted at /api/admin/settings
/**
 * @openapi
 * /api/ai/chat:
 *   post:
 *     tags: [AI]
 *     summary: E51 AI chat (n8n proxy + labelled local fallback)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message: { type: string, minLength: 1, maxLength: 2000 }
 *               bookId: { type: integer, description: 'Optional book context' }
 *     responses:
 *       '200': { description: OK — source is n8n when a webhook is configured and answers, otherwise local-fallback (never a 502), content: { application/json: { schema: { type: object, properties: { reply: { type: string }, source: { type: string, enum: [n8n, local-fallback] }, recommendations: { type: array, items: { $ref: '#/components/schemas/Book' } } } } } } }
 *       '404': { description: bookId not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/ai/suggestions:
 *   get:
 *     tags: [AI]
 *     summary: E52 AI suggestions
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: bookId, in: query, schema: { type: integer }, description: 'Book-aware prompts when given; otherwise one prompt is personalised from the reader top genre and its top book (e.g. "More Science books like 1984") when they have reading history' }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { suggestions: { type: array, items: { type: string } } } } } } }
 *       '404': { description: bookId not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/admin/settings:
 *   get:
 *     tags: [Settings]
 *     summary: E53 masked settings (admin) — the webhook URL itself is never returned
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Settings' } } } }
 * /api/admin/settings/n8n-webhook:
 *   put:
 *     tags: [Settings]
 *     summary: E54 set n8n webhook (admin)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [webhookUrl]
 *             properties:
 *               webhookUrl: { type: string, format: uri, description: 'HTTPS required for public hosts; embedded credentials are rejected' }
 *     responses:
 *       '200': { description: OK (masked settings), content: { application/json: { schema: { $ref: '#/components/schemas/Settings' } } } }
 *       '400': { description: Invalid or unsafe URL, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Settings]
 *     summary: E55 remove n8n webhook (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { n8nWebhookConfigured: { type: boolean } } } } } }
 * /api/admin/settings/n8n-webhook/test:
 *   post:
 *     tags: [Settings]
 *     summary: E56 test n8n webhook (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: Probe result, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, status: { type: integer }, error: { type: string } } } } } }
 *       '400': { description: No webhook configured, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/chat', requireAuth, validate(z.object({ message: z.string().min(1).max(2000), bookId: z.number().int().optional() })), async (req, res) => {
  let book = null;
  if (req.body.bookId != null) { book = db.get().prepare('SELECT * FROM books WHERE id=?').get(req.body.bookId); if (!book) throw notFound('Book not found'); }
  const out = await aiClient.chat(req.user.id, req.body.message, book);
  res.json(out);
});
router.get('/suggestions', requireAuth, (req, res) => {
  const d = db.get();
  let book = null;
  if (req.query.bookId !== undefined) { book = d.prepare('SELECT * FROM books WHERE id=?').get(Number(req.query.bookId)); if (!book) throw notFound('Book not found'); }
  if (book) return res.json({ suggestions: [`Summarize ${book.title}`, `Recommend books like ${book.title}`, `Discuss the themes of ${book.title}`, `Best quotes from ${book.title}`] });
  const base = ['Recommend mystery novels', 'Suggest books like 1984', 'Summarize The Great Gatsby', 'Best books for self-growth'];
  const { topGenreName, recommendations } = aiClient.computeRecommendations(req.user.id);
  // Personalise one prompt from the top genre when the user has a pattern
  // (ARCH §7.4; contract E52 exemplar: "More Science books like 1984" —
  // the prompt must anchor on the top genre's top book, not just name the
  // genre). Recommendations are rating-ordered within the top genres, so
  // the first one in the top genre is its top book.
  const hasHistory = d.prepare('SELECT COUNT(*) AS c FROM reading_progress WHERE user_id=?').get(req.user.id).c > 0 || d.prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id=?').get(req.user.id).c > 0;
  if (hasHistory && topGenreName) {
    const anchor = recommendations.find(b => b.genreName === topGenreName) || recommendations[0];
    base[0] = anchor ? `More ${topGenreName} books like ${anchor.title}` : `More ${topGenreName} books to read`;
  }
  res.json({ suggestions: base });
});
function settingsOut() { const url = aiClient.getWebhookUrl(); return { n8nWebhookConfigured: !!url, n8nWebhookHostHint: url ? aiClient.hostHint(url) : null }; }
settingsRouter.get('/', requireAdmin, (req, res) => res.json(settingsOut()));
function isPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
settingsRouter.put('/n8n-webhook', requireAdmin, validate(z.object({ webhookUrl: z.url() })), (req, res) => {
  const u = new URL(req.body.webhookUrl);
  // O-2 hardening: credentials embedded in the URL (user:pass@host) would be
  // stored, sent on every AI call, and risk leaking via logs — reject them;
  // the webhook endpoint must authenticate (if at all) some other way.
  if (u.username || u.password) throw badRequest('Webhook URL must not contain embedded credentials (remove the user:password@ part)');
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) throw badRequest('HTTPS is required for public webhook hosts (http is allowed only for loopback/LAN)');
  if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('Webhook URL must be http or https');
  db.get().prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('n8n_webhook_url', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at")
    .run(req.body.webhookUrl, req.user.id, new Date().toISOString());
  res.json(settingsOut());
});
settingsRouter.delete('/n8n-webhook', requireAdmin, (req, res) => {
  db.get().prepare("DELETE FROM settings WHERE key='n8n_webhook_url'").run();
  res.json({ n8nWebhookConfigured: false });
});
settingsRouter.post('/n8n-webhook/test', requireAdmin, async (req, res) => {
  const url = aiClient.getWebhookUrl();
  if (!url) throw badRequest('No webhook configured');
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'ping', test: true }), signal: ctrl.signal });
    clearTimeout(t);
    if (resp.ok) return res.json({ ok: true, status: resp.status });
    return res.json({ ok: false, status: resp.status, error: `Webhook responded ${resp.status}` });
  } catch (e) { return res.json({ ok: false, error: 'Webhook unreachable' }); }
});
module.exports = { router, settingsRouter };
