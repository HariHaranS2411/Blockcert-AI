'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { initDatabase, isDatabaseConfigured, checkDatabaseHealth } = require('./config/database');
const { initBlockchain, checkBlockchainHealth } = require('./config/blockchain');
const { uploadDir } = require('./utils/fileUtils');
const { errorHandler, notFoundHandler } = require('./middleware/errorMiddleware');
const certService = require('./services/certificateService');

const app = express();
const PORT = (() => {
  const n = Number(process.env.PORT);
  return Number.isInteger(n) && n > 0 ? n : 5000;
})();

/* ---------------- security ---------------- */
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        frameSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS origin not allowed.'));
    },
    credentials: false,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});
app.use('/api', globalLimiter);

/* ---------------- static frontend ---------------- */
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'], index: 'index.html' }));

// QR scanner library served from node_modules (vendored, no CDN).
app.use(
  '/vendor/qr-scanner',
  express.static(path.join(__dirname, 'node_modules/qr-scanner'), { fallthrough: true })
);

// Uploaded documents are NEVER served statically; downloads go through
// authenticated controller endpoints that check ownership.

/* ---------------- API routes ---------------- */
app.get('/api/health', async (req, res) => {
  const database = await checkDatabaseHealth();
  const blockchain = await checkBlockchainHealth();
  res.json({
    success: true,
    data: {
      database,
      blockchain,
      ai: { configured: Boolean(process.env.AI_API_KEY) },
      uptime: Math.round(process.uptime()),
    },
  });
});

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/institutions', require('./routes/institutionRoutes'));
app.use('/api/certificates', require('./routes/certificateRoutes'));
app.use('/api/verification', require('./routes/verificationRoutes'));
app.use('/api/students', require('./routes/studentRoutes'));
app.use('/api/employer', require('./routes/employerRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/ai', require('./routes/aiRoutes'));
app.use('/api/ocr', require('./routes/ocrRoutes'));
app.use('/api/qr', require('./routes/qrRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));

app.use('/api', notFoundHandler);

/* ---------------- SPA-ish HTML pages ---------------- */
const HTML_PAGES = [
  'index',
  'login',
  'signup',
  'forgot-password',
  'verify',
  'issue-certificate',
  'student-dashboard',
  'institution-dashboard',
  'employer-dashboard',
  'admin-dashboard',
  'certificate-details',
  'verification-result',
  'ai-analysis',
  'credential-profile',
  'verification-history',
  'how-it-works',
  'about',
];

for (const page of HTML_PAGES) {
  app.get(`/${page}`, (req, res) => res.sendFile(path.join(publicDir, `${page}.html`)));
}
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use(notFoundHandler);
app.use(errorHandler);

/* ---------------- startup ---------------- */
function ensureUploadDir() {
  const dir = uploadDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function start() {
  ensureUploadDir();
  initDatabase();
  initBlockchain();

  if (!isDatabaseConfigured()) {
    console.warn('[startup] DATABASE_URL is not configured. Database-backed features will report "Database connection unavailable."');
  } else {
    try {
      await checkDatabaseHealth().then((h) => {
        if (!h.connected) console.warn(`[startup] Database not reachable: ${h.message}`);
        else console.log('[startup] Database connected.');
      });
    } catch (_) {
      /* reported above */
    }
  }

  const chain = await checkBlockchainHealth();
  console.log(`[startup] Blockchain: ${chain.message}`);

  if (!process.env.AI_API_KEY) {
    console.log('[startup] AI_API_KEY is not configured. AI analysis will report "AI analysis is currently unavailable."');
  }
  if (!process.env.JWT_SECRET) {
    console.warn('[startup] JWT_SECRET is not configured. Authentication will fail until it is set.');
  }

  certService.startReconciliationJob();

  app.listen(PORT, () => {
    console.log(`BlockCert AI running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };
