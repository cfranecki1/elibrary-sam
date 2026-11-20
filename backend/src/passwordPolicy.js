const { z } = require('zod');
// F-A2 fix: bcrypt silently truncates its input at 72 BYTES, but a plain
// Zod .max(72) counts UTF-16 characters — a 30-emoji password (60 chars,
// 120 UTF-8 bytes) used to pass validation and then behave as if only its
// first 72 bytes existed (any suffix past byte 72 was decorative at login).
// Every password-SETTING schema (register E01, reset E07, change E08) must
// therefore enforce the limit in UTF-8 bytes as well as characters.
// (Login/current-password fields are verification inputs, not settings:
// they are compared against a hash that was produced under this policy.)
const MIN_CHARS = 6, MAX_CHARS = 72, MIN_BYTES = 6, MAX_BYTES = 72;
const passwordSchema = z.string().min(MIN_CHARS).max(MAX_CHARS).superRefine((pw, ctx) => {
  const bytes = Buffer.byteLength(pw, 'utf8');
  if (bytes > MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `Password is too long: it is ${bytes} bytes when UTF-8 encoded, and the limit is ${MAX_BYTES} bytes (bcrypt limit). Multibyte characters (accents, emoji, CJK) count as 2-4 bytes each — shorten the password or use fewer of them.`,
    });
  } else if (bytes < MIN_BYTES) {
    ctx.addIssue({ code: 'custom', message: `Password must be at least ${MIN_BYTES} bytes when UTF-8 encoded.` });
  }
});
module.exports = { passwordSchema, MAX_BYTES };
