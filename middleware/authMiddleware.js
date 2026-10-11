'use strict';

const jwt = require('jsonwebtoken');

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const e = new Error('Authentication is not configured (JWT_SECRET missing).');
    e.status = 503;
    throw e;
  }
  return secret;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name, institutionId: user.institution_id || null },
    jwtSecret(),
    { expiresIn: '12h' }
  );
}

/** Verifies the Bearer token and attaches { id, role, name, institutionId }. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }
  try {
    const payload = jwt.verify(token, jwtSecret());
    req.user = {
      id: Number(payload.sub),
      role: payload.role,
      name: payload.name,
      institutionId: payload.institutionId ?? null,
    };
    return next();
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Session expired or invalid. Please log in again.' });
  }
}

/** Attaches req.user when a valid token is present, otherwise continues anonymously. */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret());
      req.user = {
        id: Number(payload.sub),
        role: payload.role,
        name: payload.name,
        institutionId: payload.institutionId ?? null,
      };
    } catch (_) {
      /* anonymous */
    }
  }
  next();
}

module.exports = { signToken, requireAuth, optionalAuth };
