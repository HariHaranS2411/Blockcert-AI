'use strict';

const express = require('express');
const controller = require('../controllers/employerController');
const verificationController = require('../controllers/verificationController');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const { uploadCsv } = require('../middleware/uploadMiddleware');

const router = express.Router();

router.use(requireAuth, requireRole('EMPLOYER', 'ADMIN'));
router.get('/history', controller.history);
router.get('/bulk-template', controller.bulkTemplate);
router.post('/bulk-verify', uploadCsv, verificationController.bulkVerify);

module.exports = router;
