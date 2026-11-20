function publicUser(u) { return { id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, bio: u.bio ?? null, emailVerified: !!u.email_verified, createdAt: u.created_at }; }
function bookRow(d, row, userId) {
  const ratingRow = d.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS c FROM reviews WHERE book_id=?').get(row.id);
  const rating = ratingRow.c ? Math.round(ratingRow.avg * 10) / 10 : null;
  const out = {
    id: row.id, title: row.title, author: row.author, description: row.description, publisher: row.publisher,
    publishedYear: row.published_year, pages: row.pages, pdfPageCount: row.pdf_page_count,
    genreId: row.genre_id, genreName: row.genre_name ?? null, categoryId: row.category_id, categoryName: row.category_name ?? null,
    rating, ratingCount: ratingRow.c, hasPdf: !!row.pdf_file_name, hasCover: !!row.cover_file_name,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (userId) {
    out.isFavorite = !!d.prepare('SELECT id FROM favorites WHERE user_id=? AND book_id=?').get(userId, row.id);
    out.isDownloaded = !!d.prepare('SELECT id FROM downloads WHERE user_id=? AND book_id=?').get(userId, row.id);
    const p = d.prepare('SELECT percent FROM reading_progress WHERE user_id=? AND book_id=?').get(userId, row.id);
    out.progressPercent = p ? p.percent : 0;
  }
  return out;
}
const BOOK_SELECT = `SELECT b.*, g.name AS genre_name, c.name AS category_name FROM books b JOIN genres g ON g.id=b.genre_id JOIN categories c ON c.id=b.category_id`;
module.exports = { publicUser, bookRow, BOOK_SELECT };
