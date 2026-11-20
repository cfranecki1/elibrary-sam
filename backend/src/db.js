const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
let db = null;
function init(dbPath) {
  if (db) { try { db.close(); } catch (_) {} }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrateActivityLog(db, schema);
  return db;
}
// Migration (2026-11-20): activity_log gained 'role_changed' /
// 'status_changed' event types. CREATE TABLE IF NOT EXISTS never alters an
// existing table, and SQLite cannot ALTER a CHECK constraint — so a
// database created by an older build is migrated by rebuilding the table
// with the CURRENT schema.sql definition (single source of truth: the DDL
// is extracted from schema.sql, not duplicated here), preserving all rows.
function migrateActivityLog(d, schema) {
  const row = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activity_log'").get();
  if (!row || !row.sql || row.sql.includes("'role_changed'")) return; // fresh DB or already migrated
  const m = schema.match(/CREATE TABLE IF NOT EXISTS activity_log \([\s\S]*?\);/);
  if (!m) throw new Error('activity_log DDL not found in schema.sql');
  const createNew = m[0].replace('CREATE TABLE IF NOT EXISTS activity_log', 'CREATE TABLE activity_log_new');
  d.transaction(() => {
    d.exec(createNew);
    d.exec('INSERT INTO activity_log_new (id, actor_user_id, subject_user_id, event_type, entity_type, entity_id, summary, created_at) SELECT id, actor_user_id, subject_user_id, event_type, entity_type, entity_id, summary, created_at FROM activity_log');
    d.exec('DROP TABLE activity_log');
    d.exec('ALTER TABLE activity_log_new RENAME TO activity_log');
    d.exec('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_activity_type_created ON activity_log(event_type, created_at)');
    d.exec('CREATE INDEX IF NOT EXISTS idx_activity_subject ON activity_log(subject_user_id, created_at DESC)');
  })();
}
function get() { if (!db) throw new Error('DB not initialised'); return db; }
function close() { if (db) { db.close(); db = null; } }
module.exports = { init, get, close };
