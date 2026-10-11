'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_MIME = new Map([
  ['application/pdf', ['.pdf']],
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

function uploadDir() {
  return path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
}

function maxUploadBytes() {
  const mb = Number(process.env.MAX_UPLOAD_MB || 10);
  return mb * 1024 * 1024;
}

/**
 * Validate an uploaded file's MIME type, extension and size.
 * Returns { ok, message } - never silently accepts anything.
 */
function validateUpload({ originalname, mimetype, size }) {
  if (!originalname || !mimetype) {
    return { ok: false, message: 'File metadata is missing.' };
  }
  const ext = path.extname(originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, message: `Unsupported file extension "${ext || '(none)'}". Allowed: PDF, PNG, JPG.` };
  }
  const allowedMimes = ALLOWED_MIME.get(mimetype);
  if (!allowedMimes) {
    return { ok: false, message: `Unsupported file type "${mimetype}". Allowed: PDF, PNG, JPG.` };
  }
  if (!allowedMimes.includes(ext)) {
    return { ok: false, message: `File extension "${ext}" does not match type "${mimetype}".` };
  }
  if (typeof size === 'number' && size <= 0) {
    return { ok: false, message: 'The uploaded file is empty.' };
  }
  if (typeof size === 'number' && size > maxUploadBytes()) {
    const mb = Math.floor(maxUploadBytes() / (1024 * 1024));
    return { ok: false, message: `File is larger than the ${mb} MB limit.` };
  }
  return { ok: true, message: 'ok' };
}

/** Generate a collision-proof filename. Original names are never used on disk. */
function generateStoredFilename(originalname) {
  const ext = path.extname(originalname || '').toLowerCase() || '.bin';
  return `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`;
}

/** Resolve a stored filename inside the upload dir, preventing path traversal. */
function resolveStoredPath(storedFilename) {
  const base = uploadDir();
  const resolved = path.resolve(base, path.basename(storedFilename));
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    const e = new Error('Invalid file path.');
    e.code = 'INVALID_PATH';
    throw e;
  }
  return resolved;
}

function fileExists(storedFilename) {
  try {
    return fs.existsSync(resolveStoredPath(storedFilename));
  } catch (_) {
    return false;
  }
}

function deleteStoredFile(storedFilename) {
  try {
    fs.unlinkSync(resolveStoredPath(storedFilename));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ALLOWED_EXTENSIONS,
  uploadDir,
  maxUploadBytes,
  validateUpload,
  generateStoredFilename,
  resolveStoredPath,
  fileExists,
  deleteStoredFile,
};
