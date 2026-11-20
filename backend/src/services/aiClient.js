const db = require('../db');
const { bookRow, BOOK_SELECT } = require('../mappers');
function getWebhookUrl() { const r = db.get().prepare("SELECT value FROM settings WHERE key='n8n_webhook_url'").get(); return r ? r.value : null; }
function hostHint(url) { try { const u = new URL(url); return `${u.protocol}//${u.host}/…`; } catch { return null; } }
// Reading-pattern recommendations (ARCH §7.4): genre weights
// 3×finished + 2×in-progress + 1×favourited; unfinished books in the top
// genres, ordered by rating desc then rating count desc; cold start =
// catalogue top-rated. At most 5.
function computeRecommendations(userId) {
  const d = db.get();
  const weights = new Map();
  const add = (genreId, w) => weights.set(genreId, (weights.get(genreId) || 0) + w);
  d.prepare('SELECT b.genre_id AS g, rp.finished_at AS f FROM reading_progress rp JOIN books b ON b.id=rp.book_id WHERE rp.user_id=?').all(userId)
    .forEach(r => add(r.g, r.f ? 3 : 2));
  d.prepare('SELECT b.genre_id AS g FROM favorites f JOIN books b ON b.id=f.book_id WHERE f.user_id=?').all(userId).forEach(r => add(r.g, 1));
  const topGenres = [...weights.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const finishedIds = new Set(d.prepare('SELECT book_id FROM reading_progress WHERE user_id=? AND finished_at IS NOT NULL').all(userId).map(r => r.book_id));
  let rows = d.prepare(`${BOOK_SELECT}`).all();
  let books = rows.map(r => bookRow(d, r, userId)).filter(b => !finishedIds.has(b.id));
  if (topGenres.length) { const inTop = books.filter(b => topGenres.includes(b.genreId)); if (inTop.length) books = inTop; }
  books.sort((a, b) => ((b.rating ?? -1) - (a.rating ?? -1)) || (b.ratingCount - a.ratingCount) || (a.id - b.id));
  const topGenreName = topGenres.length ? (d.prepare('SELECT name FROM genres WHERE id=?').get(topGenres[0]) || {}).name : null;
  return { recommendations: books.slice(0, 5), topGenreName, topGenres: topGenres.map(id => (d.prepare('SELECT name FROM genres WHERE id=?').get(id) || {}).name).filter(Boolean) };
}
function isRecommendationRequest(message) { return /recommend|suggest|what (should|to) read|next book|books like/i.test(message); }
function fallbackReply(d, userId, message, book) {
  const q = message.toLowerCase();
  if (book && /summar|about|discuss|theme/.test(q)) {
    // `book` here is a raw books-table row (routes/ai.js passes SELECT *),
    // so the column is published_year; bookRow-shaped callers use
    // publishedYear. Reading only the camelCase key printed "(undefined)".
    const year = book.published_year ?? book.publishedYear;
    return { reply: `"${book.title}" by ${book.author} (${year}) — ${book.description}`, source: 'local-fallback' };
  }
  if (isRecommendationRequest(message)) {
    const { recommendations, topGenreName } = computeRecommendations(userId);
    const names = recommendations.map(b => `"${b.title}"`).join(', ');
    return { reply: topGenreName ? `Based on your reading pattern (top genre: ${topGenreName}), you might enjoy: ${names}.` : `Top-rated in the library right now: ${names}.`, source: 'local-fallback', recommendations };
  }
  // search-style fallback: match catalogue words
  const rows = d.prepare(`${BOOK_SELECT}`).all().map(r => bookRow(d, r, userId));
  const hits = rows.filter(b => q.includes(b.title.toLowerCase()) || q.includes(b.author.toLowerCase()) || (b.genreName && q.includes(b.genreName.toLowerCase())));
  if (hits.length) return { reply: `From the catalogue: ${hits.map(b => `"${b.title}" by ${b.author}`).join('; ')}.`, source: 'local-fallback' };
  if (book) return { reply: `You're reading "${book.title}" by ${book.author}. Ask me to summarise it, or for books like it.`, source: 'local-fallback' };
  return { reply: 'I can search the catalogue, recommend books from your reading pattern, or discuss a book you are reading. Try "Recommend books" or name a title or author.', source: 'local-fallback' };
}
async function chat(userId, message, book) {
  const d = db.get();
  const url = getWebhookUrl();
  const wantRecs = isRecommendationRequest(message);
  const recs = wantRecs ? computeRecommendations(userId) : null;
  if (url) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
      const payload = { message, bookId: book ? book.id : undefined, bookTitle: book ? book.title : undefined, userId, topGenres: recs ? recs.topGenres : undefined, bookContext: book && book.extracted_text ? book.extracted_text.slice(0, 4000) : undefined };
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal });
      clearTimeout(t);
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        const reply = data && (data.reply ?? data.output ?? data.text);
        if (typeof reply === 'string' && reply.length) { const out = { reply, source: 'n8n' }; if (recs) out.recommendations = recs.recommendations; return out; }
      }
    } catch (e) { /* fall through to labelled local fallback — never a 502 */ }
  }
  return fallbackReply(d, userId, message, book);
}
module.exports = { getWebhookUrl, hostHint, computeRecommendations, isRecommendationRequest, chat };
