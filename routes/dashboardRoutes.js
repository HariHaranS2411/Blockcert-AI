'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/dashboardController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests.' },
});

router.get('/public', publicLimiter, controller.publicCounts);
router.get('/', requireAuth, controller.stats);

module.exports = router;
