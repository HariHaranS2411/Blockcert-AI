'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/authController');
const { requireAuth } = require('../middleware/authMiddleware');
const { validate, registerRules, loginRules } = require('../utils/validation');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

router.post('/register', authLimiter, registerRules, validate, controller.register);
router.post('/login', authLimiter, loginRules, validate, controller.login);
router.post('/forgot-password', authLimiter, controller.forgotPassword);
router.get('/me', requireAuth, controller.me);

module.exports = router;
