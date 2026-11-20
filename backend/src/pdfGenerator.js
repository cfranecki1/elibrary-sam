// Minimal internal PDF writer (no extra dependency). Emits exactly
// pages.length pages; each entry is an array of text lines for that page.
function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function wrap(text, width = 88) {
  const words = String(text).split(/\s+/); const lines = []; let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > width) { if (line) lines.push(line); line = w; } else { line = (line + ' ' + w).trim(); } }
  if (line) lines.push(line); return lines;
}
function makePdf(pagesLines) {
  const objs = []; const pageNums = pagesLines.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageNums.map(n => n + ' 0 R').join(' ')}] /Count ${pagesLines.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pagesLines.forEach((lines, i) => {
    const pn = pageNums[i], cn = pn + 1;
    objs[pn] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cn} 0 R >>`;
    let stream = 'BT /F1 11 Tf 56 740 Td 15 TL';
    lines.forEach((ln, j) => { stream += j === 0 ? ` (${esc(ln)}) Tj` : ` T* (${esc(ln)}) Tj`; });
    stream += ' ET';
    objs[cn] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n'; const offsets = [0];
  for (let n = 1; n < objs.length; n++) { offsets[n] = Buffer.byteLength(out, 'latin1'); out += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
module.exports = { makePdf, wrap };
