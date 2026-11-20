const fs = require('fs');
const path = require('path');
const { wrap } = require('./pdfGenerator');
// Seed book content + layout (rework 2026-11-20). The shipped seed books
// used to be empty shells: ~180-443 pages carrying only a title header and
// three boilerplate chapter paragraphs. Now each book's PDF is built from
// a real prose content file (src/seed_content/<book>.txt):
//
//   line 1: book title
//   line 2: author
//   then repeating: "CHAPTER N" / chapter title / blank / paragraphs
//   (paragraphs separated by blank lines)
//
// Layout is fixed and deterministic: prose is wrapped at WRAP_WIDTH and
// flowed at BODY_LINES_PER_PAGE body lines per page, chapters flowing
// continuously (as in real typesetting — a chapter heading follows the
// previous chapter's text, and its startPage is the page the heading
// lands on, computed here, never hand-typed). EVERY page carries real
// text. The book's `pages` and `pdf_page_count` are the TRUE generated
// count — identical by construction because both come from this layout
// plus a pdf-parse verification in seed.js.
//
// The constants were chosen so the seeded reader's canonical progress
// percents survive the backend's own arithmetic exactly: with these
// counts, round(pct × pages) recomputes to precisely 35 % / 55 % / 75 %
// (DATA_MODEL §15.4). (Fresh-page chapters were evaluated and rejected:
// they only reach those percents at ~31 lines/page, far outside a
// readable layout.)
const WRAP_WIDTH = 70;
const BODY_LINES_PER_PAGE = 38;

function parseSeedContent(text) {
  const lines = String(text).split(/\r?\n/);
  const title = (lines[0] || '').trim();
  const author = (lines[1] || '').trim();
  if (!title || !author) throw new Error('seed content: missing title/author header');
  const chapters = [];
  let current = null;
  let pendingTitle = null;
  for (let i = 2; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const m = line.match(/^CHAPTER\s+(\d+)$/i);
    if (m) {
      current = { number: Number(m[1]), title: null, paragraphs: [] };
      chapters.push(current);
      pendingTitle = true;
      continue;
    }
    if (!current) continue; // front matter between author line and CHAPTER 1
    if (pendingTitle) {
      if (line) { current.title = line; pendingTitle = false; }
      continue;
    }
    if (!line) continue; // paragraph separator
    // A paragraph may span several physical lines in the file; join
    // consecutive non-blank lines into one paragraph.
    const last = current.paragraphs.length - 1;
    if (last >= 0 && lines[i - 1].trim() !== '' && !/^CHAPTER\s+\d+$/i.test(lines[i - 1].trim())) {
      current.paragraphs[last] += ' ' + line;
    } else {
      current.paragraphs.push(line);
    }
  }
  if (!chapters.length) throw new Error(`seed content for "${title}": no chapters found`);
  chapters.forEach(c => {
    if (!c.title) throw new Error(`seed content for "${title}": chapter ${c.number} has no title`);
    if (!c.paragraphs.length) throw new Error(`seed content for "${title}": chapter ${c.number} has no prose`);
  });
  return { title, author, chapters };
}

function layoutBook(parsed) {
  const pages = []; // body lines per page (header added at render time)
  let current = null;
  const newPage = () => { current = []; pages.push(current); };
  // Push one body line, opening a fresh page when the current one is full.
  // Returns the 1-based page the line landed on.
  const pushLine = ln => { if (!current || current.length >= BODY_LINES_PER_PAGE) newPage(); current.push(ln); return pages.length; };
  const chapters = parsed.chapters.map((ch, ci) => {
    if (ci === 0) newPage();
    else pushLine(''); // blank separator before a flowing chapter heading
    const startPage = pushLine(`Chapter ${ch.number}`);
    pushLine(ch.title);
    pushLine('');
    ch.paragraphs.forEach((p, pi) => {
      // Paragraph separator: a blank body line, dropped when it would top
      // a fresh page (or overflow onto one).
      if (pi > 0 && current.length < BODY_LINES_PER_PAGE) current.push('');
      wrap(p, WRAP_WIDTH).forEach(pushLine);
    });
    return { number: ch.number, title: ch.title, startPage, contentText: ch.paragraphs.join('\n\n') };
  });
  // Render: page furniture (book title header + blank) above the body.
  const pagesLines = pages.map(body => [parsed.title, '', ...body]);
  return { pagesLines, chapters, pageCount: pages.length };
}

function loadSeedBook(fileName) {
  const text = fs.readFileSync(path.join(__dirname, 'seed_content', fileName), 'utf8');
  const parsed = parseSeedContent(text);
  return { parsed, ...layoutBook(parsed) };
}
module.exports = { parseSeedContent, layoutBook, loadSeedBook, WRAP_WIDTH, BODY_LINES_PER_PAGE };
