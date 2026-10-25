'use strict';
/**
 * scripts/resync-chain.js
 *
 * Re-registers certificates whose on-chain record is missing.
 *
 * Ganache keeps its chain in memory: every restart wipes it, while the
 * database keeps its rows claiming blockchain_status='registered' with tx
 * hashes and block numbers from a chain generation that no longer exists.
 * Verification reads the chain directly (never the DB), so those stale rows
 * correctly produced "No blockchain record exists for this certificate" and
 * a SUSPICIOUS verdict for genuine certificates.
 *
 * This script, for every certificate row:
 *   - missing on chain  -> issue it again with the stored document hash via
 *     the same service function issuance uses (registerOnBlockchain), which
 *     updates tx hash / block number / status and writes an audit entry.
 *   - present but with a DIFFERENT fingerprint -> reported as a conflict and
 *     left untouched (never silently adopt the wrong record).
 *   - status REVOKED and not revoked on chain -> re-applies the revocation
 *     and updates the revocations row's tx hash.
 *
 * Usage: node scripts/resync-chain.js          (dry run: reports only)
 *        node scripts/resync-chain.js --apply  (performs the writes)
 */

require('dotenv').config();

const { ethers } = require('ethers');
const { query, initDatabase, isDatabaseConfigured } = require('./../config/database');
const { initBlockchain, getContract, getProvider, getUnavailableReason, isBlockchainConfigured } = require('./../config/blockchain');
const blockchainService = require('./../services/blockchainService');
const certService = require('./../services/certificateService');

const APPLY = process.argv.includes('--apply');

async function main() {
  initDatabase();
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL is not configured.');
    process.exit(1);
  }
  initBlockchain();
  if (!isBlockchainConfigured()) {
    console.error('Blockchain not configured:', getUnavailableReason());
    process.exit(1);
  }
  const provider = getProvider();
  const contract = getContract();
  const blockNumber = await provider.getBlockNumber();
  console.log(`Chain block ${blockNumber}, contract ${process.env.CONTRACT_ADDRESS} — mode: ${APPLY ? 'APPLY' : 'DRY RUN (add --apply)'}`);

  const result = await query(
    `SELECT id, certificate_id, status, document_hash, blockchain_status, blockchain_tx_hash, block_number
       FROM certificates ORDER BY id`
  );

  const summary = { issued: 0, revoked: 0, alreadyOk: 0, conflicts: [], noHash: [], errors: [] };

  for (const cert of result.rows) {
    let record = null;
    try {
      record = await blockchainService.getCertificateRecord(cert.certificate_id);
    } catch (err) {
      summary.errors.push(`${cert.certificate_id}: read failed: ${err.message}`);
      continue;
    }

    if (record) {
      const chainHash = String(record.certificateHash || '').toLowerCase();
      const dbHash = String(cert.document_hash || '').toLowerCase();
      if (dbHash && chainHash && chainHash !== dbHash) {
        summary.conflicts.push(`${cert.certificate_id}: chain ${chainHash.slice(0, 12)}… != db ${dbHash.slice(0, 12)}…`);
        continue;
      }
      const chainRevoked = Boolean(record.revoked);
      const dbRevoked = cert.status === 'REVOKED';
      if (dbRevoked && !chainRevoked) {
        if (!APPLY) {
          summary.revoked += 1;
          console.log(`WOULD REVOKE  ${cert.certificate_id}`);
          continue;
        }
        try {
          const receipt = await blockchainService.revokeCertificate(cert.certificate_id);
          await query(`UPDATE revocations SET blockchain_tx_hash = $2 WHERE certificate_id = $1`, [cert.id, receipt.txHash]);
          console.log(`REVOKED       ${cert.certificate_id} tx=${receipt.txHash} block=${receipt.blockNumber}`);
          summary.revoked += 1;
        } catch (err) {
          summary.errors.push(`${cert.certificate_id}: revoke failed: ${err.message}`);
        }
        continue;
      }
      summary.alreadyOk += 1;
      continue;
    }

    // Missing on chain.
    if (!cert.document_hash) {
      summary.noHash.push(cert.certificate_id);
      continue;
    }
    if (!APPLY) {
      summary.issued += 1;
      console.log(`WOULD ISSUE   ${cert.certificate_id} (${cert.status})`);
      continue;
    }
    try {
      const res = await certService.registerOnBlockchain(cert);
      if (res.ok) {
        summary.issued += 1;
        console.log(`ISSUED        ${cert.certificate_id} tx=${res.txHash || 'adopted'} block=${res.blockNumber || '-'}`);
        if (cert.status === 'REVOKED') {
          const receipt = await blockchainService.revokeCertificate(cert.certificate_id);
          await query(`UPDATE revocations SET blockchain_tx_hash = $2 WHERE certificate_id = $1`, [cert.id, receipt.txHash]);
          console.log(`REVOKED       ${cert.certificate_id} tx=${receipt.txHash}`);
          summary.revoked += 1;
        }
      } else {
        summary.errors.push(`${cert.certificate_id}: ${res.reason}`);
      }
    } catch (err) {
      summary.errors.push(`${cert.certificate_id}: ${err.message}`);
    }
  }

  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  if (!APPLY) console.log('\nDry run only — re-run with --apply to write.');
  process.exit(summary.errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
