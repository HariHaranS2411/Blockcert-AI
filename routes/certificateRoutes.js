'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/certificateController');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const { uploadDocument, uploadBulkIssuance } = require('../middleware/uploadMiddleware');
const { validate, issueCertificateRules, revokeRules, idParamRule, searchRules } = require('../utils/validation');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many uploads. Please try again later.' },
});

router.use(requireAuth);

router.post('/', requireRole('INSTITUTION', 'ADMIN'), uploadLimiter, uploadDocument, issueCertificateRules, validate, controller.createCertificate);
router.post('/bulk', requireRole('INSTITUTION', 'ADMIN'), uploadLimiter, uploadBulkIssuance, controller.bulkIssue);
router.get('/bulk-template', requireRole('INSTITUTION', 'ADMIN'), controller.bulkTemplate);
router.get('/', requireRole('INSTITUTION', 'ADMIN'), searchRules, validate, controller.listCertificates);
router.get('/:id', idParamRule, validate, controller.getCertificate);
router.get('/:id/download', idParamRule, validate, controller.downloadCertificate);
router.post('/:id/revoke', requireRole('INSTITUTION', 'ADMIN'), revokeRules, validate, controller.revokeCertificate);

module.exports = router;
