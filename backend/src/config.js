const path = require('path');
const root = path.join(__dirname, '..');
function resolveFromRoot(p) { return path.isAbsolute(p) ? p : path.join(root, p); }

const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  jwtSecret: process.env.JWT_SECRET || 'dev-placeholder-change-me',
  dbPath: resolveFromRoot(process.env.DB_PATH || 'data/elibrary.db'),
  uploadsDir: resolveFromRoot(process.env.UPLOADS_DIR || 'uploads'),
  dataDir: resolveFromRoot(process.env.DATA_DIR || 'data'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

// Boot-time validation: fail fast with a clear message instead of booting
// into a misconfigured state (coding standard: validate at every boundary).
function assertValidConfig() {
  const problems = [];
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(`PORT must be an integer 1-65535 (got "${process.env.PORT}")`);
  }
  if (!config.jwtSecret || config.jwtSecret.length < 16) {
    problems.push('JWT_SECRET must be at least 16 characters');
  }
  if (config.isProduction && config.jwtSecret === 'dev-placeholder-change-me') {
    problems.push('JWT_SECRET must be overridden in production (the dev placeholder is refused)');
  }
  if (problems.length) {
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
}

module.exports = { ...config, assertValidConfig };
