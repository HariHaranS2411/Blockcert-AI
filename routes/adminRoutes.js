'use strict';

const express = require('express');
const controller = require('../controllers/adminController');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');

const router = express.Router();

router.use(requireAuth, requireRole('ADMIN'));

router.get('/dashboard', controller.dashboard);
router.get('/users', controller.listUsers);
router.get('/institutions', controller.listInstitutions);
router.get('/certificates', controller.listCertificates);
router.get('/verifications', controller.listVerifications);
router.get('/audit-logs', controller.auditLogs);
router.patch('/institutions/:id/approve', controller.setInstitutionStatus);
router.patch('/institutions/:id/suspend', controller.setInstitutionStatus);
router.patch('/institutions/:id/reject', controller.setInstitutionStatus);
router.patch('/users/:id/suspend', controller.setUserStatus);
router.patch('/users/:id/activate', controller.setUserStatus);

module.exports = router;
