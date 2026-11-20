const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { badRequest, unauthorized, forbidden, conflict, ApiError } = require('../errors');
const { publicUser } = require('../mappers');
const { passwordSchema } = require('../passwordPolicy');
const { createNotification } = require('../services/notifications');
const { logActivity } = require('../services/activity');
const mailer = require('../services/mailer');
const router = express.Router();
const now = () => new Date().toISOString();
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
// F-02: the token proves identity ONLY — role/is_active are re-read from
// the DB per request (middleware/auth). No role claim is signed in
// (retro-review F-5.3): a claim the server ignores invites a future
// maintainer to trust it and reopen F-02.
function sign(user) { return jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '7d' }); }
function defaultUsername(d, email) {
  let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 30);
  while (base.length < 3) base += '_';
  let candidate = base, n = 1;
  while (d.prepare('SELECT id FROM users WHERE username_lower=?').get(candidate.toLowerCase())) {
    n += 1; const suffix = `_${n}`; candidate = base.slice(0, 30 - suffix.length) + suffix;
  }
  return candidate;
}
// Display names are trimmed BEFORE length validation and storage (fix
// 2026-11-20): " A" used to pass min(2) on its raw length and then be
// stored as "A". The transform makes the validated value the stored value.
const nameSchema = z.string().transform(s => s.trim()).pipe(z.string().min(2).max(80));
const registerSchema = z.object({
  name: nameSchema,
  email: z.email().max(120),
  password: passwordSchema, // F-A2: char AND UTF-8 byte length (bcrypt 72-byte cap)
  username: z.string().min(3).max(30).regex(/^[A-Za-z0-9._-]+$/).optional(),
  termsAccepted: z.literal(true),
});
/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: E01 register
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, termsAccepted]
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 80 }
 *               email: { type: string, format: email, maxLength: 120 }
 *               password: { type: string, minLength: 6, maxLength: 72, description: '6–72 chars and ≤72 UTF-8 bytes (bcrypt cap)' }
 *               username: { type: string, minLength: 3, maxLength: 30, pattern: '^[A-Za-z0-9._-]+$' }
 *               termsAccepted: { type: boolean, enum: [true] }
 *     responses:
 *       '201': { description: Created, content: { application/json: { schema: { type: object, properties: { token: { type: string }, user: { $ref: '#/components/schemas/PublicUser' }, devVerificationToken: { type: string, description: 'Non-production only (demo mailer)' } } } } } }
 *       '400': { description: Validation failed, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: Email or username already exists, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: E02 login
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { token: { type: string }, user: { $ref: '#/components/schemas/PublicUser' } } } } } }
 *       '401': { description: Invalid credentials, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: Account suspended, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '423': { description: Account locked (5 consecutive failures, 15 minutes), content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: E03 logout
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: E04 current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/PublicUser' } } } }
 *       '401': { description: Unauthenticated, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/auth/verify-email:
 *   post:
 *     tags: [Auth]
 *     summary: E05 verify email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string, minLength: 16, maxLength: 128 }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, emailVerified: { type: boolean } } } } } }
 *       '400': { description: Unknown, expired or already-used token, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: E06 forgot password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       '200': { description: Always OK (no account enumeration), content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, devResetToken: { type: string, description: 'Non-production only, and only when the account exists' } } } } } }
 * /api/auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: E07 reset password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token: { type: string, minLength: 16, maxLength: 128 }
 *               newPassword: { type: string, minLength: 6, maxLength: 72 }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '400': { description: Unknown or expired token, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: E08 change password
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string }
 *               newPassword: { type: string, minLength: 6, maxLength: 72 }
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Ok' } } } }
 *       '400': { description: New password equals current, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '401': { description: Current password incorrect, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/register', validate(registerSchema), async (req, res) => {
  const d = db.get(); const { name, email, password, username } = req.body;
  const emailLower = email.trim().toLowerCase();
  if (d.prepare('SELECT id FROM users WHERE email_lower=?').get(emailLower)) throw conflict('An account with this email already exists');
  let finalUsername = username;
  if (username) { if (d.prepare('SELECT id FROM users WHERE username_lower=?').get(username.toLowerCase())) throw conflict('That username is taken'); }
  else finalUsername = defaultUsername(d, email.trim());
  const passwordHash = await bcrypt.hash(password, 10);
  const token = newToken(); const ts = now();
  const insertUser = d.prepare(`INSERT INTO users (name, username, username_lower, email, email_lower, password_hash, role, terms_accepted_at, email_verified, verification_token_hash, verification_expires_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?, 'user', ?, 0, ?, ?, ?, ?)`);
  // F-A1: the await above opens a race window. An explicit duplicate surfaces
  // as a UNIQUE error and is mapped to the correct 409 centrally
  // (middleware/errorHandler). An AUTO-GENERATED username that loses the
  // race is not a user error, so regenerate and retry instead of failing.
  // Retro-review F-1.3 + F-5.4: user insert + welcome notification +
  // activity commit together (the mailer call stays outside — email is
  // not transactional, register already sent it after the writes), and
  // the display name is stored trimmed like every other name field.
  const user = d.transaction(() => {
    let info = null;
    for (let attempt = 0; attempt < 10 && !info; attempt++) {
      try {
        info = insertUser.run(name.trim(), finalUsername, finalUsername.toLowerCase(), email.trim(), emailLower, passwordHash, ts, hashToken(token), new Date(Date.now() + 24 * 3600e3).toISOString(), ts, ts);
      } catch (e) {
        const autoUsernameCollision = !username && e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT') && /username_lower/.test(e.message || '');
        if (!autoUsernameCollision) throw e;
        finalUsername = defaultUsername(d, email.trim());
      }
    }
    if (!info) throw conflict('That username is taken');
    const created = d.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    createNotification({ userId: created.id }, { type: 'welcome', title: 'Welcome to eLibrary', body: 'Welcome! Your account is ready — start by browsing the catalogue.', relatedType: null, relatedId: null });
    logActivity({ actorId: created.id, eventType: 'user_registered', entityType: 'user', entityId: created.id, summary: `${created.name} registered` });
    return created;
  })();
  mailer.sendVerification(user.email, token);
  const out = { token: sign(user), user: publicUser(user) };
  if (!config.isProduction) out.devVerificationToken = token;
  res.status(201).json(out);
});
router.post('/login', validate(z.object({ email: z.email(), password: z.string().min(1).max(72) })), async (req, res) => {
  const d = db.get(); const { email, password } = req.body;
  const user = d.prepare('SELECT * FROM users WHERE email_lower=?').get(email.trim().toLowerCase());
  if (!user) throw unauthorized('Invalid email or password');
  if (user.locked_until && new Date(user.locked_until) > new Date()) throw new ApiError(423, 'ACCOUNT_LOCKED', 'Account locked. Try again later.', { lockedUntil: user.locked_until });
  if (!user.is_active) throw forbidden('Account suspended');
  // Retro-review F-1.5: an EXPIRED lock resets the failure window —
  // otherwise the counter stays >= 5 and the next single wrong password
  // re-locks instantly, so an expired lock granted exactly one attempt.
  const lockExpired = user.locked_until && new Date(user.locked_until) <= new Date();
  const baseCount = lockExpired ? 0 : user.failed_login_count;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const count = baseCount + 1;
    if (count >= 5) { const until = new Date(Date.now() + 15 * 60e3).toISOString(); d.prepare('UPDATE users SET failed_login_count=?, locked_until=?, updated_at=? WHERE id=?').run(count, until, now(), user.id); throw new ApiError(423, 'ACCOUNT_LOCKED', 'Account locked after repeated failed logins.', { lockedUntil: until }); }
    d.prepare('UPDATE users SET failed_login_count=?, locked_until=NULL, updated_at=? WHERE id=?').run(count, now(), user.id);
    throw unauthorized('Invalid email or password');
  }
  d.prepare('UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=?, updated_at=? WHERE id=?').run(now(), now(), user.id);
  const fresh = d.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  res.json({ token: sign(fresh), user: publicUser(fresh) });
});
router.post('/logout', requireAuth, (req, res) => res.json({ ok: true }));
router.get('/me', requireAuth, (req, res) => res.json(publicUser(req.user)));
router.post('/verify-email', validate(z.object({ token: z.string().min(16).max(128) })), (req, res) => {
  const d = db.get();
  const user = d.prepare('SELECT * FROM users WHERE verification_token_hash=?').get(hashToken(req.body.token));
  if (!user || user.email_verified || !user.verification_expires_at || new Date(user.verification_expires_at) < new Date()) throw badRequest('Unknown, expired or already-used verification token');
  d.prepare('UPDATE users SET email_verified=1, verification_token_hash=NULL, verification_expires_at=NULL, updated_at=? WHERE id=?').run(now(), user.id);
  res.json({ ok: true, emailVerified: true });
});
router.post('/forgot-password', validate(z.object({ email: z.email() })), (req, res) => {
  const d = db.get();
  const user = d.prepare('SELECT * FROM users WHERE email_lower=?').get(req.body.email.trim().toLowerCase());
  const out = { ok: true };
  if (user) {
    const token = newToken();
    d.prepare('UPDATE users SET reset_token_hash=?, reset_expires_at=?, updated_at=? WHERE id=?').run(hashToken(token), new Date(Date.now() + 3600e3).toISOString(), now(), user.id);
    mailer.sendReset(user.email, token);
    if (!config.isProduction) out.devResetToken = token;
  }
  res.json(out);
});
router.post('/reset-password', validate(z.object({ token: z.string().min(16).max(128), newPassword: passwordSchema })), async (req, res) => {
  const d = db.get();
  const user = d.prepare('SELECT * FROM users WHERE reset_token_hash=?').get(hashToken(req.body.token));
  if (!user || !user.reset_expires_at || new Date(user.reset_expires_at) < new Date()) throw badRequest('Unknown or expired reset token');
  const hash = await bcrypt.hash(req.body.newPassword, 10);
  d.prepare('UPDATE users SET password_hash=?, reset_token_hash=NULL, reset_expires_at=NULL, failed_login_count=0, locked_until=NULL, updated_at=? WHERE id=?').run(hash, now(), user.id);
  res.json({ ok: true });
});
router.post('/change-password', requireAuth, validate(z.object({ currentPassword: z.string().min(1).max(72), newPassword: passwordSchema })), async (req, res) => {
  const ok = await bcrypt.compare(req.body.currentPassword, req.user.password_hash);
  if (!ok) throw unauthorized('Current password is incorrect');
  if (req.body.newPassword === req.body.currentPassword) throw badRequest('New password must differ from the current password');
  const hash = await bcrypt.hash(req.body.newPassword, 10);
  db.get().prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(hash, now(), req.user.id);
  res.json({ ok: true });
});
module.exports = router;
