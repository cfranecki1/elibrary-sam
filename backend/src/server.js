require('dotenv').config({ quiet: true });
const config = require('./config');
try {
  config.assertValidConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const { createApp } = require('./app');
const db = require('./db');
createApp().then(app => {
  const server = app.listen(config.port, () => console.log(`E-Library v2 backend listening on :${config.port}`));
  // Retro-review F-6.2: a listen failure (e.g. EADDRINUSE) gets the same
  // clean 'Boot failed' path as a createApp failure, and SIGTERM/SIGINT
  // close the server + DB instead of relying on process death with a
  // WAL database left to recover.
  server.on('error', err => { console.error('Boot failed', err); process.exit(1); });
  const shutdown = signal => {
    console.log(`${signal} received — shutting down`);
    server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch(err => { console.error('Boot failed', err); process.exit(1); });
