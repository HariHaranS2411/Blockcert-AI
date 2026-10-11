'use strict';

const express = require('express');
const controller = require('../controllers/studentController');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');

const router = express.Router();

router.get('/me/certificates', requireAuth, requireRole('STUDENT'), controller.myCertificates);
router.get('/me/resume', requireAuth, requireRole('STUDENT'), controller.buildResume);
router.get('/me/resume-profile', requireAuth, requireRole('STUDENT'), controller.getResumeProfile);
router.put('/me/resume-profile', requireAuth, requireRole('STUDENT'), controller.saveResumeProfile);
router.get('/me/credentials', requireAuth, requireRole('STUDENT'), controller.myCredentials);
router.get('/me/history', requireAuth, requireRole('STUDENT'), controller.myHistory);
router.get('/:id/public-profile', controller.publicProfile);

module.exports = router;
