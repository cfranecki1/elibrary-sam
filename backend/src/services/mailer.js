// DEMO mailer (ARCHITECTURE §5.2): no mail server exists in the demo setup.
// Links are logged to the backend console; dev-mode responses carry the raw
// token (NODE_ENV != production only). The real limitation is stated in
// backend/README.md. Supabase Auth email is the deferred migration path.
function sendVerification(email, token) { console.log(`[mailer:demo] verification link for ${email}: /verify-email?token=${token}`); }
function sendReset(email, token) { console.log(`[mailer:demo] password reset link for ${email}: /reset-password?token=${token}`); }
module.exports = { sendVerification, sendReset };
