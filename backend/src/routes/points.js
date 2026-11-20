const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { badRequest } = require('../errors');
const { totalPoints } = require('../services/points');
const router = express.Router();
const KEYS = ['first_book', 'five_books', 'ten_books', 'first_review', 'bookworm_500pts', 'downloader_5'];
/**
 * @openapi
 * /api/leaderboard:
 *   get:
 *     tags: [Points]
 *     summary: E68 leaderboard + me
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 50 } }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { entries: { type: array, items: { type: object, properties: { rank: { type: integer }, user: { type: object, properties: { id: { type: integer }, name: { type: string }, username: { type: string } } }, points: { type: integer }, booksRead: { type: integer } } } }, me: { type: object, properties: { rank: { type: integer, nullable: true }, points: { type: integer }, booksRead: { type: integer } } } } } } } }
 *       '400': { description: Bad limit, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 * /api/points/me:
 *   get:
 *     tags: [Points]
 *     summary: E69 my points/achievements/history
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { points: { type: integer }, achievements: { type: array, items: { type: object, properties: { key: { type: string }, unlockedAt: { type: string, nullable: true, format: date-time } } } }, history: { type: array, items: { type: object, properties: { eventType: { type: string }, points: { type: integer }, createdAt: { type: string, format: date-time } } } } } } } } }
 */
router.get('/leaderboard', requireAuth, (req, res) => {
  const d = db.get();
  let limit = Number(req.query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest('Bad limit');
  limit = Math.min(limit, 50);
  const users = d.prepare('SELECT * FROM users').all().map(u => ({
    user: { id: u.id, name: u.name, username: u.username },
    points: totalPoints(u.id),
    booksRead: d.prepare('SELECT COUNT(*) AS c FROM reading_progress WHERE user_id=? AND finished_at IS NOT NULL').get(u.id).c,
    uid: u.id,
  }));
  users.sort((a, b) => (b.points - a.points) || (b.booksRead - a.booksRead) || (a.uid - b.uid));
  const ranked = users.map((u, i) => ({ rank: i + 1, user: u.user, points: u.points, booksRead: u.booksRead, uid: u.uid }));
  const mine = ranked.find(r => r.uid === req.user.id);
  res.json({ entries: ranked.slice(0, limit).map(({ uid, ...rest }) => rest), me: mine ? { rank: mine.rank, points: mine.points, booksRead: mine.booksRead } : { rank: null, points: 0, booksRead: 0 } });
});
router.get('/points/me', requireAuth, (req, res) => {
  const d = db.get();
  const unlocked = d.prepare('SELECT * FROM user_achievements WHERE user_id=?').all(req.user.id);
  const achievements = KEYS.map(key => ({ key, unlockedAt: (unlocked.find(a => a.achievement_key === key) || {}).unlocked_at ?? null }));
  const history = d.prepare('SELECT * FROM points_events WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 50').all(req.user.id)
    .map(e => ({ eventType: e.event_type, points: e.points, createdAt: e.created_at }));
  res.json({ points: totalPoints(req.user.id), achievements, history });
});
module.exports = router;
