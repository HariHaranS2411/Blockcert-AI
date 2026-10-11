'use strict';

const { query } = require('../config/database');
const qrService = require('../services/qrService');

/** GET /api/qr/:certificateId - PNG QR containing only the public verify URL */
async function getQr(req, res, next) {
  try {
    const certificateId = String(req.params.certificateId).trim().toUpperCase();
    if (!/^CERT-\d{4}-\d{6}$/.test(certificateId)) {
      return res.status(400).json({ success: false, message: 'Certificate ID must use the format CERT-YYYY-XXXXXX.' });
    }

    const result = await query('SELECT certificate_id FROM certificates WHERE certificate_id = $1', [certificateId]);
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: 'Certificate Not Found.' });
    }

    const buffer = await qrService.generateQrBuffer(certificateId);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename="${certificateId}.png"`);
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
}

module.exports = { getQr };
