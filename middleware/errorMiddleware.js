'use strict';

/** Centralized error handler. Never exposes stack traces or internals. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const code = err.code;

  if (code === 'DB_UNAVAILABLE') {
    return res.status(503).json({ success: false, message: 'Database connection unavailable.' });
  }
  if (code === 'BLOCKCHAIN_UNAVAILABLE') {
    return res.status(503).json({ success: false, message: err.message || 'Blockchain verification is currently unavailable.' });
  }
  if (code === 'AI_UNAVAILABLE') {
    return res.status(503).json({ success: false, message: 'AI analysis is currently unavailable.' });
  }
  if (code === 'OCR_UNAVAILABLE') {
    return res.status(err.status || 422).json({ success: false, message: err.message || 'Unable to extract sufficient text from this document.' });
  }
  if (code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'The uploaded file exceeds the size limit.' });
  }
  if (code === 'EBADCSRFTOKEN' || code === 'INVALID_PATH') {
    return res.status(400).json({ success: false, message: err.message || 'Invalid request.' });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, '-', err.message);
  }
  const message = status >= 500 ? 'An unexpected error occurred. Please try again.' : err.message;
  return res.status(status).json({ success: false, message });
}

/** 404 for unknown API routes. */
function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'Endpoint not found.' });
}

module.exports = { errorHandler, notFoundHandler };
