const express = require('express');
const fs = require('fs');
const cors = require('cors');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const db = require('./db');
const { seedIfEmpty } = require('./seed');
const { errorHandler } = require('./middleware/errorHandler');
const { rateLimitAuth } = require('./middleware/rateLimitAuth');
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const genreRoutes = require('./routes/genres');
const categoryRoutes = require('./routes/categories');
const bookRoutes = require('./routes/books');
const chapterRoutes = require('./routes/chapters');
const favoriteRoutes = require('./routes/favorites');
const downloadRoutes = require('./routes/downloads');
const progressRoutes = require('./routes/progress');
const sessionRoutes = require('./routes/readingSessions');
const reviewRoutes = require('./routes/reviews');
const { router: requestRoutes, adminRouter: adminRequestRoutes } = require('./routes/requests');
const notificationRoutes = require('./routes/notifications');
const { router: aiRoutes, settingsRouter } = require('./routes/ai');
const communityRoutes = require('./routes/community');
const { router: contactRoutes, adminRouter: adminContactRoutes } = require('./routes/contact');
const pointsRoutes = require('./routes/points');
const adminRoutes = require('./routes/admin');
async function createApp() {
  // Runtime dirs are not guaranteed to exist on first boot (custom env,
  // fresh clone): seed PDFs live in DATA_DIR and uploads in UPLOADS_DIR,
  // so create both before anything writes into them.
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  db.init(config.dbPath);
  await seedIfEmpty();
  const app = express();
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  /**
   * @openapi
   * /api/health:
   *   get:
   *     tags: [System]
   *     summary: E70 health
   *     responses:
   *       '200': { description: OK, content: { application/json: { schema: { type: object, properties: { status: { type: string }, db: { type: string }, time: { type: string, format: date-time } } } } } }
   *       '503': { description: Database unreachable, content: { application/json: { schema: { type: object, properties: { status: { type: string }, db: { type: string }, time: { type: string, format: date-time } } } } } }
   */
  app.get('/api/health', (req, res) => {
    // Retro-review F-2.3: a failed DB probe must not report ok/200 —
    // monitors key on the status code and the status field.
    try { db.get().prepare('SELECT 1').get(); } catch (e) {
      console.error('[health] DB probe failed', e && e.message ? e.message : e);
      return res.status(503).json({ status: 'error', db: 'error', time: new Date().toISOString() });
    }
    res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  });
  app.use('/api/auth', rateLimitAuth, authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/genres', genreRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/books', bookRoutes);
  app.use('/api', chapterRoutes);
  app.use('/api', reviewRoutes);
  app.use('/api/favorites', favoriteRoutes);
  app.use('/api/downloads', downloadRoutes);
  app.use('/api/progress', progressRoutes);
  app.use('/api/reading-sessions', sessionRoutes);
  app.use('/api/requests', requestRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/community', communityRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api', pointsRoutes);
  app.use('/api/admin/requests', adminRequestRoutes);
  app.use('/api/admin/settings', settingsRouter);
  app.use('/api/admin/contact-messages', adminContactRoutes);
  app.use('/api/admin', adminRoutes);
  const spec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: { title: 'E-Library v2 API', version: '1.0.0', description: 'Endpoints E01–E71 (see docs/API_CONTRACT.md)' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        // Shared response/request shapes (API_CONTRACT §0: the annotations
        // must describe the same shapes as the contract). Route files
        // reference these via $ref; shapes mirror src/mappers.js and the
        // route serializers exactly.
        schemas: {
          Error: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' }, details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } } }, required: ['error', 'code'] },
          Ok: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          PublicUser: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, username: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', enum: ['user', 'admin'] }, bio: { type: 'string', nullable: true }, emailVerified: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' } } },
          Book: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, author: { type: 'string' }, description: { type: 'string' }, publisher: { type: 'string' }, publishedYear: { type: 'integer' }, pages: { type: 'integer' }, pdfPageCount: { type: 'integer', nullable: true }, genreId: { type: 'integer' }, genreName: { type: 'string', nullable: true }, categoryId: { type: 'integer' }, categoryName: { type: 'string', nullable: true }, rating: { type: 'number', nullable: true }, ratingCount: { type: 'integer' }, hasPdf: { type: 'boolean' }, hasCover: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, isFavorite: { type: 'boolean' }, isDownloaded: { type: 'boolean' }, progressPercent: { type: 'integer' } } },
          ChapterRef: { type: 'object', properties: { id: { type: 'integer' }, chapterNumber: { type: 'integer' }, title: { type: 'string' }, startPage: { type: 'integer', nullable: true } } },
          Chapter: { type: 'object', properties: { id: { type: 'integer' }, bookId: { type: 'integer' }, chapterNumber: { type: 'integer' }, title: { type: 'string' }, contentText: { type: 'string' }, startPage: { type: 'integer', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
          Genre: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, description: { type: 'string', nullable: true }, sortOrder: { type: 'integer' }, bookCount: { type: 'integer' } } },
          Category: { type: 'object', properties: { id: { type: 'integer' }, genreId: { type: 'integer' }, genreName: { type: 'string', nullable: true }, name: { type: 'string' }, description: { type: 'string', nullable: true }, bookCount: { type: 'integer' } } },
          Review: { type: 'object', properties: { id: { type: 'integer' }, rating: { type: 'integer' }, reviewText: { type: 'string' }, user: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, name: { type: 'string' }, username: { type: 'string' } } }, adminResponse: { type: 'string', nullable: true }, adminResponseAt: { type: 'string', nullable: true, format: 'date-time' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
          BookRequest: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, author: { type: 'string' }, reason: { type: 'string', nullable: true }, status: { type: 'string', enum: ['Pending', 'Resolved', 'Rejected'] }, adminNote: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, user: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, name: { type: 'string' }, username: { type: 'string' } } }, resolvedByUser: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, name: { type: 'string' }, username: { type: 'string' } } } } },
          Notification: { type: 'object', properties: { id: { type: 'integer' }, type: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, relatedType: { type: 'string', nullable: true }, relatedId: { type: 'integer', nullable: true }, isRead: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' } } },
          ProgressRow: { type: 'object', properties: { bookId: { type: 'integer' }, currentPage: { type: 'integer' }, totalPages: { type: 'integer' }, percent: { type: 'integer' }, lastReadAt: { type: 'string', format: 'date-time' }, finishedAt: { type: 'string', nullable: true, format: 'date-time' }, readingSeconds: { type: 'integer' }, book: { $ref: '#/components/schemas/Book' } } },
          ActivityItem: { type: 'object', properties: { id: { type: 'integer' }, eventType: { type: 'string' }, summary: { type: 'string' }, actor: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, name: { type: 'string' } } }, createdAt: { type: 'string', format: 'date-time' } } },
          AdminUser: { allOf: [{ $ref: '#/components/schemas/PublicUser' }, { type: 'object', properties: { isActive: { type: 'boolean' }, lastLoginAt: { type: 'string', nullable: true, format: 'date-time' }, booksRead: { type: 'integer' }, points: { type: 'integer' } } }] },
          ContactMessage: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' }, subject: { type: 'string' }, message: { type: 'string' }, status: { type: 'string', enum: ['New', 'Read'] }, createdAt: { type: 'string', format: 'date-time' } } },
          CommunityMessage: { type: 'object', properties: { id: { type: 'integer' }, body: { type: 'string' }, user: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, name: { type: 'string' }, username: { type: 'string' } } }, createdAt: { type: 'string', format: 'date-time' } } },
          Settings: { type: 'object', properties: { n8nWebhookConfigured: { type: 'boolean' }, n8nWebhookHostHint: { type: 'string', nullable: true } } },
        },
      },
    },
    apis: [`${__dirname}/routes/*.js`, `${__dirname}/app.js`],
    failOnErrors: config.nodeEnv !== 'production',
  });
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec));
  app.get('/api-docs.json', (req, res) => res.json(spec));
  // Unknown API routes -> §9 404 envelope
  app.use('/api/{*splat}', (req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
