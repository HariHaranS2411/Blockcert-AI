'use strict';

const { ethers } = require('ethers');
const {
  getContract,
  getProvider,
  getWallet,
  getUnavailableReason,
  isBlockchainConfigured,
} = require('../config/blockchain');
const { toBytes32 } = require('./hashService');

/**
 * Every value returned by this service comes from a real chain call.
 * When the chain is not configured or unreachable it throws a
 * BLOCKCHAIN_UNAVAILABLE error which surfaces as an honest error state.
 */

async function issueCertificate(certificateId, sha256Hex) {
  const contract = getContract();
  const wallet = getWallet();
  const bytes32 = toBytes32(sha256Hex);
  try {
    const tx = await contract.issueCertificate(certificateId, bytes32);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      const e = new Error('Blockchain transaction was rejected.');
      e.code = 'BLOCKCHAIN_UNAVAILABLE';
      throw e;
    }
    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      timestamp: new Date().toISOString(),
      issuerAddress: await wallet.getAddress(),
    };
  } catch (err) {
    throw wrapChainError(err);
  }
}

async function revokeCertificate(certificateId) {
  const contract = getContract();
  try {
    const tx = await contract.revokeCertificate(certificateId);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      const e = new Error('Blockchain revocation transaction was rejected.');
      e.code = 'BLOCKCHAIN_UNAVAILABLE';
      throw e;
    }
    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    throw wrapChainError(err);
  }
}

/**
 * Read the authoritative record for a certificate ID from the chain.
 * Returns null when no record exists (a real "not found" on-chain).
 */
async function getCertificateRecord(certificateId) {
  const contract = getContract();
  try {
    const result = await contract.verifyCertificate(certificateId, ethers.ZeroHash);
    const [exists, , revoked, issuer, timestamp] = result;
    if (!exists) return null;

    // verifyCertificate with ZeroHash tells us existence/revocation/issuer;
    // fetch the real stored hash separately so we never report a fake value.
    const storedHash = await contract.getCertificateHash(certificateId);
    return {
      exists: true,
      certificateHash: storedHash.toLowerCase().replace(/^0x/, ''),
      issuer,
      timestamp: Number(timestamp),
      timestampIso: new Date(Number(timestamp) * 1000).toISOString(),
      revoked: Boolean(revoked),
    };
  } catch (err) {
    if (err.code === 'RecordNotFound') return null;
    throw wrapChainError(err);
  }
}

/** Compare an uploaded document hash against the on-chain record. */
async function compareHash(certificateId, sha256Hex) {
  const contract = getContract();
  const bytes32 = toBytes32(sha256Hex);
  try {
    const [exists, hashMatch] = await contract.verifyCertificate(certificateId, bytes32);
    return { exists: Boolean(exists), hashMatch: Boolean(hashMatch) };
  } catch (err) {
    throw wrapChainError(err);
  }
}

/**
 * Look up the real CertificateIssued event for a certificate ID.
 * Used when adopting a chain record that already exists (reconciliation):
 * returns the real tx hash and block number of the original registration.
 */
async function findIssuanceEvent(certificateId) {
  const contract = getContract();
  try {
    const filter = contract.filters.CertificateIssued(null, certificateId);
    const events = await contract.queryFilter(filter, 0, 'latest');
    if (!events.length) return null;
    const event = events[events.length - 1];
    return {
      txHash: event.transactionHash,
      blockNumber: event.blockNumber,
      issuer: event.args ? event.args.issuer : null,
      timestamp: event.args ? Number(event.args.timestamp) : null,
    };
  } catch (err) {
    throw wrapChainError(err);
  }
}

async function isRevoked(certificateId) {
  const record = await getCertificateRecord(certificateId);
  if (!record) return null;
  return record.revoked;
}

async function getIssuerAddress(certificateId) {
  const record = await getCertificateRecord(certificateId);
  return record ? record.issuer : null;
}

/** Real connectivity check used by system health. */
async function ping() {
  const reason = getUnavailableReason();
  if (reason) return { ok: false, message: reason };
  try {
    const provider = getProvider();
    await provider.getBlockNumber();
    return { ok: true, message: 'Connected.' };
  } catch (err) {
    return { ok: false, message: 'Blockchain verification is currently unavailable. ' + (err.shortMessage || err.message) };
  }
}

function wrapChainError(err) {
  if (err.code === 'BLOCKCHAIN_UNAVAILABLE') return err;
  const e = new Error(
    'Blockchain verification is currently unavailable. ' + (err.shortMessage || err.reason || err.message || '')
  );
  e.code = 'BLOCKCHAIN_UNAVAILABLE';
  e.cause = err;
  return e;
}

module.exports = {
  issueCertificate,
  revokeCertificate,
  getCertificateRecord,
  compareHash,
  findIssuanceEvent,
  isRevoked,
  getIssuerAddress,
  ping,
  isBlockchainConfigured,
};
