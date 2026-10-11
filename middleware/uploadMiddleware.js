'use strict';

const multer = require('multer');
const { uploadDir, validateUpload, generateStoredFilename, maxUploadBytes } = require('../utils/fileUtils');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir());
  },
  filename(req, file, cb) {
    cb(null, generateStoredFilename(file.originalname));
  },
});

function fileFilter(req, file, cb) {
  const check = validateUpload({ originalname: file.originalname, mimetype: file.mimetype });
  if (!check.ok) {
    const err = new Error(check.message);
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxUploadBytes(), files: 1 },
});

/** Single file field "document". Maps multer errors to the standard envelope. */
function uploadDocument(req, res, next) {
  upload.single('document')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.floor(maxUploadBytes() / (1024 * 1024));
        return res.status(400).json({ success: false, message: `File is larger than the ${mb} MB limit.` });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: err.message });
      }
      return res.status(err.status || 400).json({ success: false, message: err.message || 'Upload failed.' });
    }
    return next();
  });
}

/** CSV file field "file" for bulk operations. */
const csvStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir());
  },
  filename(req, file, cb) {
    cb(null, generateStoredFilename(file.originalname || 'bulk.csv'));
  },
});

function csvFilter(req, file, cb) {
  const name = (file.originalname || '').toLowerCase();
  const okMime = file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || file.mimetype === 'text/plain';
  const okExt = name.endsWith('.csv');
  if (!okExt) {
    const err = new Error('Bulk upload must be a .csv file.');
    err.status = 400;
    return cb(err);
  }
  if (!okMime && file.mimetype !== 'application/octet-stream') {
    const err = new Error(`Unsupported file type "${file.mimetype}" for bulk upload.`);
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

const csvUpload = multer({
  storage: csvStorage,
  fileFilter: csvFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

function uploadCsv(req, res, next) {
  csvUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'CSV file is larger than the 5 MB limit.' });
      }
      return res.status(err.status || 400).json({ success: false, message: err.message || 'Upload failed.' });
    }
    return next();
  });
}

/**
 * Bulk issuance upload: one CSV (field "file") plus optional certificate
 * documents (field "documents", multiple). CSV rows reference attached
 * documents by their original file name in the documentPath column.
 */
const bulkIssuanceUpload = multer({
  storage: csvStorage,
  fileFilter(req, file, cb) {
    if (file.fieldname === 'file') return csvFilter(req, file, cb);
    return fileFilter(req, file, cb);
  },
  limits: { fileSize: maxUploadBytes(), files: 101 },
});

function uploadBulkIssuance(req, res, next) {
  bulkIssuanceUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'documents', maxCount: 100 },
  ])(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.floor(maxUploadBytes() / (1024 * 1024));
        return res.status(400).json({ success: false, message: `A file is larger than the ${mb} MB limit.` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ success: false, message: 'Bulk issuance is limited to 1 CSV plus 100 documents.' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ success: false, message: 'Unexpected upload field. Use "file" for the CSV and "documents" for certificate files.' });
      }
      return res.status(err.status || 400).json({ success: false, message: err.message || 'Upload failed.' });
    }
    return next();
  });
}

module.exports = { uploadDocument, uploadCsv, uploadBulkIssuance };
