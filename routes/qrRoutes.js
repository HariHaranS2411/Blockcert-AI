'use strict';

const express = require('express');
const qrController = require('../controllers/qrController');

const router = express.Router();

// Public: the QR embeds only the certificate's public verification URL.
router.get('/:certificateId', qrController.getQr);

module.exports = router;
