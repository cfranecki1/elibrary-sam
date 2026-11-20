// Hosted-deployment entry point: serves the compiled Flutter web app and
// the API from one origin/port. The project's own src/server.js stays
// untouched for local use.
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const config = require('./src/config');
try { config.assertValidConfig(); } catch (err) { console.error(err.message); process.exit(1); }
const { createApp } = require('./src/app');
const db = require('./src/db');

createApp().then(api => {
  const webDir = path.join(__dirname, '..', 'web');
  const parent = express();
  parent.use(express.static(webDir, { index: false }));
  parent.use(api);
  parent.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(webDir, 'index.html'));
    }
    return next();
  });
  const port = parseInt(process.env.PORT || '7860', 10);
  const server = parent.listen(port, '0.0.0.0', () => console.log(`E-Library live (app + API) on :${port}`));
  server.on('error', err => { console.error('Boot failed', err); process.exit(1); });
  const shutdown = signal => { console.log(`${signal} received`); server.close(() => { try { db.close(); } catch (_) {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch(err => { console.error('Boot failed', err); process.exit(1); });
