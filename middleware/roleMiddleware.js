'use strict';

const { query } = require('../config/database');

/** Allow only the listed roles (server-side; never trust the client). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action.',
      });
    }
    return next();
  };
}

/**
 * Ownership check: an institution user may only act on certificates belonging
 * to its own institution, regardless of what IDs the client sends.
 */
async function assertOwnsCertificate(req, certificateRow) {
  if (req.user.role === 'ADMIN') return true;
  if (req.user.role !== 'INSTITUTION') return false;
  if (!req.user.institutionId) return false;
  return Number(certificateRow.institution_id) === Number(req.user.institutionId);
}

/** Loads a certificate row or throws a 404-style error. */
async function loadCertificateById(id) {
  const result = await query('SELECT * FROM certificates WHERE id = $1', [id]);
  return result.rows[0] || null;
}

module.exports = { requireRole, assertOwnsCertificate, loadCertificateById };
