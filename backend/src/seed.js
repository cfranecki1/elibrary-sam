const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const { makePdf } = require('./pdfGenerator');
const { loadSeedBook } = require('./seedContent');
const { extractPdf } = require('./services/pdfText');
const now = () => new Date().toISOString();
const GENRES = [
  ['Fiction', ['Classic Fiction', 'Literary Fiction']],
  ['Mystery', ['Crime', 'Thriller']],
  ['Romance', ['Contemporary Romance', 'Historical Romance']],
  ['Science', ['Dystopian Fiction', 'Popular Science']],
  ['History', ['World History', 'Ancient History']],
  ['Biography', ['Memoir', 'Historical Biography']],
  ['Self-help', ['Personal Development', 'Productivity']],
];
const BOOKS = [
  { title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', genre: 'Fiction', category: 'Classic Fiction', contentFile: 'gatsby.txt', year: 1925, publisher: 'Scribner', ratings: [5, 5, 4, 5, 4], description: 'A portrait of the Jazz Age in 1920s New York, told through the eyes of Nick Carraway as he is drawn into the glittering, mysterious world of Jay Gatsby. A short novel about wealth, longing and the American Dream.' },
  { title: '1984', author: 'George Orwell', genre: 'Science', category: 'Dystopian Fiction', contentFile: '1984.txt', year: 1949, publisher: 'Secker & Warburg', ratings: [5, 5, 4, 5, 4, 5, 4, 5, 5, 5], description: 'Winston Smith lives in a society where the Party watches every move and controls every thought. Orwell\'s chilling vision of totalitarianism remains one of the most influential novels ever written.' },
  { title: 'To Kill a Mockingbird', author: 'Harper Lee', genre: 'Fiction', category: 'Classic Fiction', contentFile: 'mockingbird.txt', year: 1960, publisher: 'J.B. Lippincott & Co.', ratings: [5, 5, 5, 4, 5], description: 'Through the eyes of young Scout Finch, a small Southern town confronts conscience and prejudice when her father, Atticus, defends a man falsely accused. A story of childhood, courage and justice.' },
  { title: 'Sapiens: A Brief History of Humankind', author: 'Yuval Noah Harari', genre: 'History', category: 'World History', contentFile: 'sapiens.txt', year: 2011, publisher: 'Harper', ratings: [5, 5, 4, 5, 4], description: 'A sweeping tour of how Homo sapiens came to dominate the world, from insignificant apes to builders of empires, money and myths. Big history told with clarity and wit.' },
  { title: 'The Power of Habit', author: 'Charles Duhigg', genre: 'Self-help', category: 'Personal Development', contentFile: 'habit.txt', year: 2012, publisher: 'Random House', ratings: [5, 4, 4, 5, 4], description: 'Why habits exist, how they are formed, and how they can be changed — in individuals, organisations and societies. A practical tour of the cue-routine-reward loop.' },
];
const REVIEW_TEXTS = ['A wonderful read, highly recommended.', 'Really enjoyed this one.', 'Good book, worth the time.', 'An excellent addition to the library.', 'Solid and engaging throughout.'];
// Atomicity rule (retro-review F-1.1): the gate below ("genres exist =>
// seeded") is only sound if seeding is all-or-nothing. So: (1) every PDF is
// generated and page-count-verified BEFORE any insert — the only awaits in
// this function live in that phase; (2) all inserts then run inside ONE
// synchronous better-sqlite3 transaction. A failure in phase 1 leaves the
// DB untouched; a failure in phase 2 rolls the DB back. Either way the next
// boot retries from a clean slate instead of wedging on a half-catalogue.
// (Seed PDF files are written inside the transaction under deterministic
// names — seed-book-<id>.pdf — so a rolled-back attempt's files are simply
// overwritten by the retry, never orphaned under a different id.)
async function seedIfEmpty() {
  const d = db.get();
  if (d.prepare('SELECT COUNT(*) AS c FROM genres').get().c > 0) return false;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const ts = now();
  // Phase 1 (async, no DB writes): build each book's PDF from its real
  // prose content file (seedContent.js). `pages` IS the generated count —
  // the layout count and the pdf-parse count must agree exactly, or the
  // seed aborts before touching the DB (rework 2026-11-20: the old F-01
  // rule padded books to their bibliographic page counts with empty
  // header-only pages; the books are now exactly as long as their text).
  const prepared = [];
  for (const b of BOOKS) {
    const layout = loadSeedBook(b.contentFile);
    if (layout.parsed.title !== b.title || layout.parsed.author !== b.author) {
      throw new Error(`seed content header mismatch for ${b.contentFile}: "${layout.parsed.title}" / "${layout.parsed.author}"`);
    }
    const pdf = makePdf(layout.pagesLines);
    const extracted = await extractPdf(pdf);
    if (extracted.pages !== layout.pageCount) throw new Error(`seed PDF page count mismatch for ${b.title}: extracted ${extracted.pages} != layout ${layout.pageCount}`);
    prepared.push({ book: b, layout, pdf, extracted });
  }
  // Password hashes are also computed before the transaction (sync but slow).
  const adminHash = bcrypt.hashSync(process.env.SEED_ADMIN_PASSWORD || 'admin123', 10);
  const readerHash = bcrypt.hashSync('reader123', 10);
  // Per-user hashes (own salt each), as before — computed outside the txn.
  const reviewerHashes = Array.from({ length: 10 }, () => bcrypt.hashSync('reviewer123', 10));
  // Phase 2 (sync, one transaction): every insert or none.
  d.transaction(() => {
    const genreIds = {}, categoryIds = {};
    GENRES.forEach(([name, cats], i) => {
      const g = d.prepare('INSERT INTO genres (name, name_lower, description, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(name, name.toLowerCase(), `${name} books`, i + 1, ts, ts);
      genreIds[name] = g.lastInsertRowid;
      cats.forEach(cn => {
        const c = d.prepare('INSERT INTO categories (genre_id, name, name_lower, description, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(g.lastInsertRowid, cn, cn.toLowerCase(), null, ts, ts);
        categoryIds[cn] = c.lastInsertRowid;
      });
    });
    // Users: admin, demo reader, 10 review-only reviewers (seed inserts bypass
    // the notification/points services — DATA_MODEL §15.5).
    const adminId = d.prepare(`INSERT INTO users (name, username, username_lower, email, email_lower, password_hash, role, terms_accepted_at, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?, 'admin', ?, 1, ?, ?)`)
      .run('Library Admin', 'admin', 'admin', 'admin@elibrary.com', 'admin@elibrary.com', adminHash, ts, ts, ts).lastInsertRowid;
    const readerId = d.prepare(`INSERT INTO users (name, username, username_lower, email, email_lower, password_hash, role, terms_accepted_at, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?, 'user', ?, 1, ?, ?)`)
      .run('Demo Reader', 'reader', 'reader', 'reader@elibrary.com', 'reader@elibrary.com', readerHash, ts, ts, ts).lastInsertRowid;
    // DATA_MODEL §15.3: reviewers are ordinary named people (usernames and
    // emails stay reviewer01..10; only the display names are realistic).
    const REVIEWER_NAMES = ['Ayesha Khan', 'Bilal Ahmed', 'Fatima Noor', 'Usman Tariq', 'Maryam Siddiqui', 'Ali Raza', 'Hira Shahid', 'Omar Farooq', 'Zainab Iqbal', 'Hamza Sheikh'];
    const reviewerIds = [];
    for (let i = 1; i <= 10; i++) {
      const uname = `reviewer${String(i).padStart(2, '0')}`;
      const id = d.prepare(`INSERT INTO users (name, username, username_lower, email, email_lower, password_hash, role, terms_accepted_at, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?, 'user', ?, 1, ?, ?)`)
        .run(REVIEWER_NAMES[i - 1], uname, uname, `${uname}@elibrary.com`, `${uname}@elibrary.com`, reviewerHashes[i - 1], ts, ts, ts).lastInsertRowid;
      reviewerIds.push(id);
    }
    const bookIds = {};
    const pageCounts = {};
    for (const { book: b, layout, pdf, extracted } of prepared) {
      const info = d.prepare(`INSERT INTO books (title, title_lower, author, author_lower, description, publisher, published_year, pages, genre_id, category_id, pdf_page_count, extracted_text, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(b.title, b.title.toLowerCase(), b.author, b.author.toLowerCase(), b.description, b.publisher, b.year, layout.pageCount, genreIds[b.genre], categoryIds[b.category], extracted.pages, extracted.text, adminId, ts, ts);
      const bookId = info.lastInsertRowid; bookIds[b.title] = bookId; pageCounts[b.title] = layout.pageCount;
      const fileName = `seed-book-${bookId}.pdf`;
      fs.writeFileSync(path.join(config.dataDir, fileName), pdf);
      d.prepare('UPDATE books SET pdf_file_name=?, pdf_original_name=? WHERE id=?').run(fileName, `${b.title}.pdf`, bookId);
      layout.chapters.forEach(ch => {
        d.prepare('INSERT INTO chapters (book_id, chapter_number, title, title_lower, content_text, start_page, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(bookId, ch.number, ch.title, ch.title.toLowerCase(), ch.contentText, ch.startPage, ts, ts);
      });
      b.ratings.forEach((rating, i) => {
        const isGatsbyFirst = b.title === 'The Great Gatsby' && i === 0;
        d.prepare('INSERT INTO reviews (book_id, user_id, rating, review_text, admin_response, admin_response_by, admin_response_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(bookId, reviewerIds[i], rating, REVIEW_TEXTS[i % REVIEW_TEXTS.length], isGatsbyFirst ? 'Thank you for the thoughtful review!' : null, isGatsbyFirst ? adminId : null, isGatsbyFirst ? ts : null, ts, ts);
      });
    }
    // Demo reader: welcome notification (direct insert, §15.5), favorites,
    // download, progress at the canonical 35 % / 55 % / 75 % of the NEW
    // page counts (currentPage = round(pct × pages); the layout constants
    // were chosen so the backend-derived percent is exact — §15.4),
    // seeded sessions, points = 11.
    d.prepare('INSERT INTO notifications (user_id, type, title, body, related_type, related_id, is_read, created_at) VALUES (?,?,?,?,NULL,NULL,0,?)')
      .run(readerId, 'welcome', 'Welcome to eLibrary', 'Welcome! Your account is ready — start by browsing the catalogue.', ts);
    const gatsby = bookIds['The Great Gatsby'], orwell = bookIds['1984'], mock = bookIds['To Kill a Mockingbird'];
    d.prepare('INSERT INTO favorites (user_id, book_id, created_at) VALUES (?,?,?)').run(readerId, gatsby, ts);
    d.prepare('INSERT INTO favorites (user_id, book_id, created_at) VALUES (?,?,?)').run(readerId, orwell, ts);
    d.prepare('INSERT INTO downloads (user_id, book_id, downloaded_at) VALUES (?,?,?)').run(readerId, gatsby, ts);
    const prog = [['The Great Gatsby', 35], ['1984', 55], ['To Kill a Mockingbird', 75]]
      .map(([title, pctWanted]) => {
        const tot = pageCounts[title];
        return [bookIds[title], Math.round((pctWanted / 100) * tot), tot];
      });
    prog.forEach(([bookId, cur, tot], i) => {
      const pct = Math.round((100 * cur) / tot);
      const t = new Date(Date.now() - (3 - i) * 24 * 3600e3).toISOString();
      d.prepare('INSERT INTO reading_progress (user_id, book_id, current_page, total_pages, percent, last_read_at, finished_at) VALUES (?,?,?,?,?,?,NULL)').run(readerId, bookId, cur, tot, pct, t);
    });
    // Seeded sessions: durations produced by the §8A rule simulated with
    // 60-second heartbeats (each interval <= the 120 s cap).
    const sessionPlan = [[gatsby, 900], [gatsby, 600], [orwell, 1200], [mock, 780]];
    sessionPlan.forEach(([bookId, duration], i) => {
      const start = new Date(Date.now() - (4 - Math.floor(i / 2)) * 24 * 3600e3);
      const end = new Date(start.getTime() + duration * 1000);
      d.prepare('INSERT INTO reading_sessions (user_id, book_id, started_at, last_heartbeat_at, ended_at, duration_seconds, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(readerId, bookId, start.toISOString(), end.toISOString(), end.toISOString(), duration, start.toISOString(), end.toISOString());
    });
    d.prepare("INSERT INTO points_events (user_id, event_type, points, related_type, related_id, created_at) VALUES (?, 'book_downloaded', 5, 'book', ?, ?)").run(readerId, gatsby, ts);
    [2, 1, 0].forEach(daysAgo => {
      const t = new Date(Date.now() - daysAgo * 24 * 3600e3).toISOString();
      d.prepare("INSERT INTO points_events (user_id, event_type, points, related_type, related_id, created_at) VALUES (?, 'daily_reading', 2, NULL, NULL, ?)").run(readerId, t);
    });
    if (process.env.N8N_WEBHOOK_URL) {
      d.prepare("INSERT OR IGNORE INTO settings (key, value, updated_by, updated_at) VALUES ('n8n_webhook_url', ?, NULL, ?)").run(process.env.N8N_WEBHOOK_URL, ts);
    }
  })();
  return true;
}
module.exports = { seedIfEmpty };
