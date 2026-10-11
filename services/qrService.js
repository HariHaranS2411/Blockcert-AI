'use strict';

const QRCode = require('qrcode');

/**
 * QR codes contain ONLY the public verification URL.
 * No personal data, no hashes, no private fields are ever embedded.
 */

function verificationUrl(certificateId) {
  const base = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${base}/verify.html?id=${encodeURIComponent(certificateId)}`;
}

async function generateQrDataUrl(certificateId) {
  const url = verificationUrl(certificateId);
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
}

async function generateQrBuffer(certificateId) {
  const url = verificationUrl(certificateId);
  return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512 });
}

module.exports = { verificationUrl, generateQrDataUrl, generateQrBuffer };
