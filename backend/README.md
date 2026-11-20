# E-Library v2 — Backend

Express 5 + SQLite (better-sqlite3) API for the E-Library v2 app, built from
scratch against `../docs/API_CONTRACT.md` (endpoints E01–E71). Swagger UI is
served at **`/api-docs`**.

## Run

```bash
npm install
npm start          # http://localhost:4000  (PORT env to change)
npm test           # Jest + Supertest suite (uses a temporary database)
```

On first boot against an empty database the server seeds the canonical
catalogue (7 genres, 14 categories, the 5 demo books with generated PDFs
built from real prose content files in `src/seed_content/` — every page
carries text; `pages` is the true generated count: 26/31/32/33/30 — with
their real chapter lists, 12–14 chapters each, and seed reviews that
reproduce the canonical ratings), plus these **demo accounts**:

| Account | Email | Password |
|---|---|---|
| Admin | `admin@elibrary.com` | `admin123` (or `$SEED_ADMIN_PASSWORD` at first boot) |
| Demo reader | `reader@elibrary.com` | `reader123` |
| Reviewers ×10 | `reviewer01@elibrary.com` … `reviewer10@elibrary.com` | `reviewer123` |

The 10 reviewer accounts exist so the seeded reviews reproduce the
canonical ratings; their display names are ordinary person names
(DATA_MODEL §15.3).

These are demonstration credentials for a coursework demo — never reuse them
anywhere real.

**Login lockout:** 5 consecutive failed login attempts lock the account
for 15 minutes; while locked, login returns HTTP 423 (`ACCOUNT_LOCKED`).
A successful login — or the lock expiring — resets the failure counter.

## Configuration

See `.env.example` (PORT, NODE_ENV, JWT_SECRET, DB_PATH, UPLOADS_DIR,
DATA_DIR, CORS_ORIGIN). The n8n webhook for the AI assistant is **not** an
env var in normal operation: an admin pastes it in the app's
Settings → Integrations (stored in the backend `settings` table, only ever
returned masked). `N8N_WEBHOOK_URL` may seed it on first boot only.

## Demo email limitation — read this

**This demo backend does not send real email.** There is no mail server in
the demo setup: email-verification and password-reset links are **logged to
the backend console**, and — only while `NODE_ENV` is not `production` —
the API responses include the raw token (`devVerificationToken` /
`devResetToken`) so the flow can be completed in the demo app. Accounts can
sign in before verifying. Sending real confirmation email is part of the
**deferred Supabase migration** (Supabase Auth), which the owner scheduled
for when the project is complete; until then, verification/reset is a
demonstration flow, not a production mail system.

## Layout

`src/server.js` (entry) · `src/app.js` (app factory, exported for tests) ·
`src/db.js` (only better-sqlite3 consumer) · `src/schema.sql` ·
`src/seed.js` · `src/routes/` · `src/services/` · `src/middleware/`.
Uploaded PDFs/covers live in `uploads/`, the SQLite file and generated seed
PDFs in `data/` (both runtime-only, git-ignored).
