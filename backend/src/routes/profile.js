const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { conflict } = require('../errors');
const { publicUser } = require('../mappers');
const mailer = require('../services/mailer');
const router = express.Router();
const now = () => new Date().toISOString();
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
/**
 * @openapi
 * /api/profile:
 *   get:
 *     tags: [Profile]
 *     summary: E09 profile + stats
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { allOf: [{ $ref: '#/components/schemas/PublicUser' }, { type: object, properties: { stats: { type: object, properties: { booksRead: { type: integer }, avgRatingGiven: { type: number, nullable: true }, points: { type: integer }, favoritesCount: { type: integer }, downloadsCount: { type: integer }, totalReadingSeconds: { type: integer } } } } }] } } } }
 *   put:
 *     tags: [Profile]
 *     summary: E10 update profile
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 80, description: 'Trimmed before validation and storage' }
 *               username: { type: string, minLength: 3, maxLength: 30, pattern: '^[A-Za-z0-9._-]+$' }
 *               email: { type: string, format: email, maxLength: 120, description: 'Changing it resets emailVerified and sends a new verification token' }
 *               bio: { type: string, maxLength: 300, nullable: true }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { allOf: [{ $ref: '#/components/schemas/PublicUser' }, { type: object, properties: { devVerificationToken: { type: string, description: 'Non-production only, present when the email changed' } } }] } } } }
 *       '400': { description: Validation failed, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Username or email taken, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (req, res) => {
  const d = db.get(); const u = req.user;
  const one = sql => d.prepare(sql).get(u.id);
  const booksRead = one('SELECT COUNT(*) AS c FROM reading_progress WHERE user_id=? AND finished_at IS NOT NULL').c;
  const avg = one('SELECT AVG(rating) AS a FROM reviews WHERE user_id=?').a;
  const points = one('SELECT COALESCE(SUM(points),0) AS t FROM points_events WHERE user_id=?').t;
  const favoritesCount = one('SELECT COUNT(*) AS c FROM favorites WHERE user_id=?').c;
  const downloadsCount = one('SELECT COUNT(*) AS c FROM downloads WHERE user_id=?').c;
  const totalReadingSeconds = one('SELECT COALESCE(SUM(duration_seconds),0) AS t FROM reading_sessions WHERE user_id=?').t;
  res.json({ ...publicUser(u), stats: { booksRead, avgRatingGiven: avg == null ? null : Math.round(avg * 10) / 10, points, favoritesCount, downloadsCount, totalReadingSeconds } });
});
const updateSchema = z.object({
  // Same trim-before-validate rule as registration (E01/E10 consistency,
  // fix 2026-11-20): surrounding spaces are never stored and never count
  // toward the minimum length.
  name: z.string().transform(s => s.trim()).pipe(z.string().min(2).max(80)).optional(),
  username: z.string().min(3).max(30).regex(/^[A-Za-z0-9._-]+$/).optional(),
  email: z.email().max(120).optional(),
  bio: z.string().max(300).nullable().optional(),
}).refine(o => Object.keys(o).length >= 1, { error: 'At least one field is required' });
router.put('/', requireAuth, validate(updateSchema), (req, res) => {
  const d = db.get(); const u = req.user; const b = req.body;
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name=?'); vals.push(b.name); }
  if (b.bio !== undefined) { sets.push('bio=?'); vals.push(b.bio); }
  if (b.username !== undefined) {
    const dup = d.prepare('SELECT id FROM users WHERE username_lower=? AND id<>?').get(b.username.toLowerCase(), u.id);
    if (dup) throw conflict('That username is taken');
    sets.push('username=?', 'username_lower=?'); vals.push(b.username, b.username.toLowerCase());
  }
  let devVerificationToken;
  if (b.email !== undefined && b.email.trim().toLowerCase() !== u.email_lower) {
    const dup = d.prepare('SELECT id FROM users WHERE email_lower=? AND id<>?').get(b.email.trim().toLowerCase(), u.id);
    if (dup) throw conflict('That email is taken');
    const token = crypto.randomBytes(32).toString('hex');
    sets.push('email=?', 'email_lower=?', 'email_verified=0', 'verification_token_hash=?', 'verification_expires_at=?');
    vals.push(b.email.trim(), b.email.trim().toLowerCase(), hashToken(token), new Date(Date.now() + 24 * 3600e3).toISOString());
    mailer.sendVerification(b.email.trim(), token);
    if (!config.isProduction) devVerificationToken = token;
  }
  sets.push('updated_at=?'); vals.push(now(), u.id);
  d.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  const fresh = d.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  const out = publicUser(fresh);
  if (devVerificationToken) out.devVerificationToken = devVerificationToken;
  res.json(out);
});
module.exports = router;
