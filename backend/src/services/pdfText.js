const { PDFParse } = require('pdf-parse');
const { ApiError } = require('../errors');
// pdf-parse 2.4.5 class API. SPIKE FINDING (T-SP-BE-02, 2026-11-09): the
// runtime + .d.ts field for page count is `total`, NOT `totalPages` as the
// upstream README / STACK_VERIFICATION claimed. We read `total` first and
// tolerate `totalPages` defensively. destroy() runs in finally, always.
async function extractPdf(buffer) {
  let parser;
  try {
    // Retro-review F-2.5: construction inside the try (a constructor
    // throw used to escape as a raw 500 instead of the 422 mapping).
    parser = new PDFParse({ data: buffer });
    const text = await parser.getText();
    const info = await parser.getInfo();
    const pages = (text && (text.total ?? text.totalPages)) ?? (info && (info.total ?? info.totalPages));
    if (pages == null) throw new Error('page count missing');
    return { pages, text: (text && text.text) || '' };
  } catch (e) {
    throw new ApiError(422, 'PDF_UNREADABLE', 'The uploaded PDF could not be read');
  } finally {
    // A destroy() failure must never mask the real result or the 422.
    if (parser) {
      try { await parser.destroy(); } catch (_) { /* cleanup only */ }
    }
  }
}
module.exports = { extractPdf };
