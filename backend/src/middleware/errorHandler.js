const multer = require('multer');
const { ApiError } = require('../errors');
// F-A1 fix: a duplicate that slips past a handler's pre-check (e.g. two
// parallel registrations racing across the `await bcrypt.hash` window, or a
// parallel book create racing across PDF extraction) surfaces as a raw
// better-sqlite3 UNIQUE-constraint error. Map it here — centrally, so every
// present and future route returns the same 409 body its sequential
// pre-check would have produced — instead of leaking a 500 INTERNAL.
// Keys are the exact "table.column" names SQLite reports; composite keys
// match when every reported column belongs to the entry's column set.
const UNIQUE_409 = [
  { cols: ['users.email_lower'], message: 'An account with this email already exists' },
  { cols: ['users.username_lower'], message: 'That username is taken' },
  { cols: ['genres.name_lower'], message: 'A genre with this name already exists' },
  // Composite uniques must list EVERY column of the constraint: SQLite
  // reports all of them and the matcher below requires exact set equality
  // (retro-review F-1.2 — single-column entries here could never match).
  { cols: ['categories.genre_id', 'categories.name_lower'], message: 'A category with this name already exists in this genre' },
  { cols: ['books.title_lower', 'books.author_lower'], message: 'A book with this title and author already exists' },
  { cols: ['chapters.book_id', 'chapters.title_lower'], message: 'A chapter with this title already exists in this book' },
  { cols: ['chapters.book_id', 'chapters.chapter_number'], message: 'A chapter with this number already exists in this book' },
];
function uniqueConstraintConflict(err) {
  if (!err || typeof err.code !== 'string' || !err.code.startsWith('SQLITE_CONSTRAINT')) return null;
  const m = /UNIQUE constraint failed: (.+)$/.exec(err.message || '');
  if (!m) return null; // NOT NULL / CHECK / FK violations stay 500: those are server bugs, not user conflicts
  const failed = m[1].split(',').map(s => s.trim());
  // SQLite reports every column of the violated index, so exact set equality is the match rule.
  const hit = UNIQUE_409.find(e => e.cols.length === failed.length && e.cols.every(c => failed.includes(c)));
  const message = hit ? hit.message : 'Resource already exists';
  return new ApiError(409, 'CONFLICT', message);
}
// Central error handler — the single §9 envelope for every error.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large', code: 'FILE_TOO_LARGE' });
    return res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
  }
  if (err instanceof ApiError) {
    const body = { error: err.message, code: err.code, ...err.extra };
    return res.status(err.status).json(body);
  }
  const unique = uniqueConstraintConflict(err);
  if (unique) return res.status(unique.status).json({ error: unique.message, code: unique.code });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body', code: 'VALIDATION_ERROR' });
  // Retro-review F-2.1: an oversized JSON body is a client error (413),
  // not a 500 — body-parser tags it entity.too.large.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
  // Retro-review F-6.1: the one error log line must carry enough context
  // to find the request at 3am — method, path, status, user.
  console.error(`[error] ${req.method} ${req.originalUrl} -> 500 (user ${req.user && req.user.id != null ? req.user.id : 'anon'})`, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
}
module.exports = { errorHandler, uniqueConstraintConflict };
