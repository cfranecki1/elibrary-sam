CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  terms_accepted_at TEXT NOT NULL,
  bio TEXT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_token_hash TEXT NULL,
  verification_expires_at TEXT NULL,
  reset_token_hash TEXT NULL,
  reset_expires_at TEXT NULL,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE TABLE IF NOT EXISTS genres (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  description TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  description TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(genre_id, name_lower)
);
CREATE INDEX IF NOT EXISTS idx_categories_genre ON categories(genre_id);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_lower TEXT NOT NULL,
  author TEXT NOT NULL,
  author_lower TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  published_year INTEGER NOT NULL,
  pages INTEGER NOT NULL CHECK (pages > 0),
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE RESTRICT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  pdf_file_name TEXT NULL,
  pdf_original_name TEXT NULL,
  cover_file_name TEXT NULL,
  cover_original_name TEXT NULL,
  pdf_page_count INTEGER NULL,
  extracted_text TEXT NULL,
  created_by INTEGER NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(title_lower, author_lower)
);
CREATE INDEX IF NOT EXISTS idx_books_genre ON books(genre_id);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(category_id);
CREATE INDEX IF NOT EXISTS idx_books_author_lower ON books(author_lower);
CREATE INDEX IF NOT EXISTS idx_books_title_lower ON books(title_lower);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL CHECK (chapter_number > 0),
  title TEXT NOT NULL,
  title_lower TEXT NOT NULL,
  content_text TEXT NOT NULL DEFAULT '',
  start_page INTEGER NULL CHECK (start_page >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, title_lower),
  UNIQUE(book_id, chapter_number)
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  downloaded_at TEXT NOT NULL,
  UNIQUE(user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id);
CREATE TABLE IF NOT EXISTS reading_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  book_id INTEGER NOT NULL REFERENCES books(id),
  current_page INTEGER NOT NULL DEFAULT 1 CHECK (current_page >= 1),
  total_pages INTEGER NOT NULL DEFAULT 0,
  percent INTEGER NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
  last_read_at TEXT NOT NULL,
  finished_at TEXT NULL,
  UNIQUE(user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_user_recent ON reading_progress(user_id, last_read_at DESC);
CREATE TABLE IF NOT EXISTS reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  book_id INTEGER NOT NULL REFERENCES books(id),
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  ended_at TEXT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_book ON reading_sessions(user_id, book_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_started ON reading_sessions(user_id, started_at DESC);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT NOT NULL DEFAULT '',
  admin_response TEXT NULL,
  admin_response_by INTEGER NULL REFERENCES users(id),
  admin_response_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, user_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('welcome','request_created','request_status','review_response','new_book','contact_reply')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  related_type TEXT NULL,
  related_id INTEGER NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at DESC);
CREATE TABLE IF NOT EXISTS book_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  reason TEXT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Resolved','Rejected')),
  admin_note TEXT NULL,
  resolved_by INTEGER NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_user ON book_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON book_requests(status);
CREATE TABLE IF NOT EXISTS community_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_created ON community_messages(created_at);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NULL REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Read')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS points_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('book_finished','review_written','book_downloaded','request_resolved','daily_reading')),
  points INTEGER NOT NULL,
  related_type TEXT NULL,
  related_id INTEGER NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  achievement_key TEXT NOT NULL CHECK (achievement_key IN ('first_book','five_books','ten_books','first_review','bookworm_500pts','downloader_5')),
  unlocked_at TEXT NOT NULL,
  UNIQUE(user_id, achievement_key)
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NULL REFERENCES users(id),
  subject_user_id INTEGER NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('user_registered','book_created','book_updated','book_deleted','book_opened','book_downloaded','review_created','request_created','request_status','message_deleted','contact_replied','role_changed','status_changed')),
  entity_type TEXT NULL,
  entity_id INTEGER NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_type_created ON activity_log(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_subject ON activity_log(subject_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NULL,
  updated_by INTEGER NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
