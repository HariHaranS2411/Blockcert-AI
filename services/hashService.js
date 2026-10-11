'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { sha256Buffer, timingSafeEqualHex } = require('../utils/cryptoUtils');

/**
 * SHA-256 of the real uploaded file, streamed (constant memory).
 * Returns lowercase hex - this is the fingerprint stored off-chain and on-chain.
 */
async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function hashBuffer(buffer) {
  return sha256Buffer(buffer);
}

/** Compare two hex fingerprints in constant time. */
function hashesEqual(a, b) {
  return timingSafeEqualHex(a, b);
}

/** "0x" prefixed bytes32 form used by the smart contract. */
function toBytes32(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const e = new Error('Invalid SHA-256 fingerprint format.');
    e.status = 400;
    throw e;
  }
  return '0x' + hex.toLowerCase();
}

module.exports = { hashFile, hashBuffer, hashesEqual, toBytes32 };
