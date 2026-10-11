'use strict';

const express = require('express');
const ocrController = require('../controllers/ocrController');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const { uploadDocument } = require('../middleware/uploadMiddleware');

const router = express.Router();

// Real extraction from the uploaded file; user reviews before issuance.
router.post('/extract', requireAuth, requireRole('INSTITUTION', 'ADMIN'), uploadDocument, ocrController.extract);

module.exports = router;
