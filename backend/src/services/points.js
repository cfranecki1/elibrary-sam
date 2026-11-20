const db = require('../db');
const AWARDS = { book_finished: 50, review_written: 10, book_downloaded: 5, request_resolved: 5, daily_reading: 2 };
function totalPoints(userId) { const r = db.get().prepare('SELECT COALESCE(SUM(points),0) AS t FROM points_events WHERE user_id=?').get(userId); return r.t; }
function alreadyAwarded(userId, eventType, relatedId, dayScoped) {
  const d = db.get();
  if (dayScoped) { const today = new Date().toISOString().slice(0, 10); return !!d.prepare("SELECT id FROM points_events WHERE user_id=? AND event_type=? AND substr(created_at,1,10)=?").get(userId, eventType, today); }
  return !!d.prepare('SELECT id FROM points_events WHERE user_id=? AND event_type=? AND related_id IS ?').get(userId, eventType, relatedId);
}
function awardPoints(userId, eventType, { relatedType = null, relatedId = null } = {}) {
  const dayScoped = eventType === 'daily_reading';
  if (alreadyAwarded(userId, eventType, relatedId, dayScoped)) return false;
  db.get().prepare('INSERT INTO points_events (user_id, event_type, points, related_type, related_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, eventType, AWARDS[eventType], relatedType, relatedId, new Date().toISOString());
  checkAchievements(userId);
  return true;
}
function unlock(userId, key) { db.get().prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_key, unlocked_at) VALUES (?,?,?)').run(userId, key, new Date().toISOString()); }
function checkAchievements(userId) {
  const d = db.get();
  const finished = d.prepare('SELECT COUNT(*) AS c FROM reading_progress WHERE user_id=? AND finished_at IS NOT NULL').get(userId).c;
  if (finished >= 1) unlock(userId, 'first_book'); if (finished >= 5) unlock(userId, 'five_books'); if (finished >= 10) unlock(userId, 'ten_books');
  const reviews = d.prepare('SELECT COUNT(*) AS c FROM reviews WHERE user_id=?').get(userId).c;
  if (reviews >= 1) unlock(userId, 'first_review');
  const downloads = d.prepare('SELECT COUNT(*) AS c FROM downloads WHERE user_id=?').get(userId).c;
  if (downloads >= 5) unlock(userId, 'downloader_5');
  if (totalPoints(userId) >= 500) unlock(userId, 'bookworm_500pts');
}
module.exports = { awardPoints, checkAchievements, totalPoints, AWARDS };
