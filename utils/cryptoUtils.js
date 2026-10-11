'use strict';

const crypto = require('crypto');

/** SHA-256 of a buffer, lowercase hex. */
function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Constant-time hex string comparison. */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch (_) {
    return false;
  }
}

/** URL-safe random token. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Hash for storing one-time tokens (never store raw tokens). */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { sha256Buffer, timingSafeEqualHex, randomToken, hashToken };
