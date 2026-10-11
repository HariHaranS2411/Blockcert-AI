'use strict';

const express = require('express');
const controller = require('../controllers/institutionController');
const { requireAuth } = require('../middleware/authMiddleware');
const { validate, institutionRules } = require('../utils/validation');

const router = express.Router();

router.get('/', controller.listInstitutions);
router.post('/', requireAuth, institutionRules, validate, controller.createInstitution);
router.get('/:id', requireAuth, controller.getInstitution);
router.put('/:id', requireAuth, institutionRules, validate, controller.updateInstitution);

module.exports = router;
