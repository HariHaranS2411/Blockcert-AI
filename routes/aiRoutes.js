'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const aiController = require('../controllers/aiController');
const { requireAuth } = require('../middleware/authMiddleware');
const { uploadDocument } = require('../middleware/uploadMiddleware');

const router = express.Router();

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests. Please try again later.' },
});

// Real provider call (503 + "AI analysis is currently unavailable." when unconfigured)
router.post('/analyze', requireAuth, aiLimiter, uploadDocument, aiController.analyze);
router.get('/:certificateId', requireAuth, aiController.getAnalyses);

// AI polish for the student resume summary (facts always server-side)
router.post('/resume-summary', requireAuth, aiController.resumeSummary);

module.exports = router;
