'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/verificationController');
const { requireAuth, optionalAuth } = require('../middleware/authMiddleware');
const { uploadDocument, uploadCsv } = require('../middleware/uploadMiddleware');
const { validate, certificateIdRule } = require('../utils/validation');

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification requests. Please try again later.' },
});

// Public verification (works without login).
router.post('/id', verifyLimiter, optionalAuth, certificateIdRule, validate, controller.verifyById);
router.post('/upload', verifyLimiter, optionalAuth, uploadDocument, controller.verifyUpload);
router.post('/qr', verifyLimiter, optionalAuth, controller.verifyQr);
router.post('/bulk', verifyLimiter, requireAuth, uploadCsv, controller.bulkVerify);

router.get('/history', requireAuth, controller.history);
router.get('/:id', requireAuth, (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Verification record not found.' });
  }
  return controller.getVerification(req, res, next);
});

module.exports = router;
