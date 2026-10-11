'use strict';

const path = require('path');
const ocrService = require('../services/ocrService');
const { deleteStoredFile } = require('../utils/fileUtils');

/**
 * POST /api/ocr/extract - real OCR on an uploaded document.
 * Returns extracted suggestions for the issuance review screen.
 * Values are suggestions only - the user must confirm or correct them.
 */
async function extract(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'A certificate document (PDF/PNG/JPG) is required.' });
    }

    const result = await ocrService.extractFields(req.file.path, req.file.mimetype);
    deleteStoredFile(path.basename(req.file.path));

    if (result.status !== 'completed') {
      const guidance =
        result.status === 'insufficient'
          ? 'Unable to extract sufficient text from this document. If it is a scanned or image-only PDF, save the page as PNG or JPG and upload it again so image OCR can read it, or fill the fields manually.'
          : `Text extraction failed: ${result.error}`;
      return res.status(422).json({
        success: false,
        message: guidance,
        data: { status: result.status, fields: {}, text: result.text || '' },
      });
    }

    return res.json({
      success: true,
      message: 'Text extracted. Review and correct each field before issuing.',
      data: {
        status: result.status,
        fields: result.fields,
        text: result.text,
        requiresReview: true,
      },
    });
  } catch (err) {
    if (req.file) deleteStoredFile(path.basename(req.file.path));
    return next(err);
  }
}

module.exports = { extract };
