'use strict';

/**
 * verificationService - all verification logic lives here.
 *
 * Public functions used by routes/controllers:
 *   findCertificate, getBlockchainRecord, calculateHash, compareHash,
 *   checkIssuer, checkRevocation, runAIAnalysis, generateFinalResult,
 *   saveVerificationHistory, verifyById, verifyUpload
 *
 * Every value produced by this service comes from a real database row, a real
 * SHA-256 computation, a real chain call or a real AI call. When a dependency
 * is unavailable the result carries an honest "unavailable" state - never a
 * fabricated pass.
 */

const fs = require('fs');
const { query, withTransaction } = require('../config/database');
const hashService = require('./hashService');
const blockchainService = require('./blockchainService');
const aiService = require('./aiService');
const ocrService = require('./ocrService');
const { resolveStoredPath, fileExists } = require('../utils/fileUtils');

const PUBLIC_MESSAGE =
  'The certificate record and blockchain registration were found.';

/* ------------------------------------------------------------------ */
/* 1. findCertificate                                                  */
/* ------------------------------------------------------------------ */
async function findCertificate(certificateId) {
  const result = await query(
    `SELECT c.*, i.name AS institution_name, i.verification_status AS institution_status,
            i.wallet_address AS institution_wallet, i.official_email AS institution_email,
            i.website AS institution_website
       FROM certificates c
       JOIN institutions i ON i.id = c.institution_id
      WHERE c.certificate_id = $1`,
    [certificateId]
  );
  return result.rows[0] || null;
}

/* ------------------------------------------------------------------ */
/* 2. getBlockchainRecord - real chain read (never trusts the DB)      */
/* ------------------------------------------------------------------ */
async function getBlockchainRecord(certificateId) {
  try {
    const record = await blockchainService.getCertificateRecord(certificateId);
    return { available: true, record, error: null };
  } catch (err) {
    return { available: false, record: null, error: err.message || 'Blockchain verification is currently unavailable.' };
  }
}

/* ------------------------------------------------------------------ */
/* 3. calculateHash - SHA-256 of the real uploaded file               */
/* ------------------------------------------------------------------ */
async function calculateHash(filePath) {
  return hashService.hashFile(filePath);
}

/* ------------------------------------------------------------------ */
/* 4. compareHash                                                      */
/* ------------------------------------------------------------------ */
function compareHash(uploadedHash, blockchainHash) {
  if (!uploadedHash || !blockchainHash) return false;
  return hashService.hashesEqual(uploadedHash, blockchainHash);
}

/* ------------------------------------------------------------------ */
/* 5. checkIssuer - approval status + on-chain issuer wallet           */
/* ------------------------------------------------------------------ */
function checkIssuer(certRow, chainRecord) {
  if (!certRow) return { verified: false, message: 'Certificate record not found.' };
  const approved = certRow.institution_status === 'APPROVED';
  let walletMatch = true;
  if (approved && chainRecord && certRow.institution_wallet && chainRecord.issuer) {
    walletMatch = certRow.institution_wallet.toLowerCase() === String(chainRecord.issuer).toLowerCase();
  }
  const verified = approved && walletMatch;
  let message;
  if (!approved) {
    message = `Issuing institution status is ${certRow.institution_status || 'unknown'} (approval pending).`;
  } else if (!walletMatch) {
    message = 'The institution wallet does not match the on-chain issuer address.';
  } else {
    message = 'Issuer is approved and matches the on-chain issuer.';
  }
  return { verified, approved, walletMatch, message };
}

/* ------------------------------------------------------------------ */
/* 6. checkRevocation                                                  */
/* ------------------------------------------------------------------ */
async function checkRevocation(certRow, chainRecord) {
  const dbRevoked = certRow && certRow.status === 'REVOKED';
  const chainRevoked = Boolean(chainRecord && chainRecord.revoked);

  let reason = null;
  let revokedAt = null;
  if (dbRevoked) {
    const rev = await query(
      'SELECT reason, revoked_at FROM revocations WHERE certificate_id = $1 ORDER BY revoked_at DESC LIMIT 1',
      [certRow.id]
    );
    if (rev.rows[0]) {
      reason = rev.rows[0].reason;
      revokedAt = rev.rows[0].revoked_at;
    }
  }

  return {
    revoked: dbRevoked || chainRevoked,
    dbRevoked,
    chainRevoked,
    reason,
    revokedAt,
    message: dbRevoked || chainRevoked ? 'This certificate has been revoked by the issuing institution.' : 'No revocation recorded.',
  };
}

/* ------------------------------------------------------------------ */
/* 7. runAIAnalysis - only when a document + a configured AI exist     */
/* ------------------------------------------------------------------ */
async function runAIAnalysis({ certRow, filePath, mimetype, certificateId, persistForId }) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { available: false, performed: false, message: 'No document was provided, so AI analysis was not performed.' };
  }
  if (!aiService.isConfigured()) {
    return { available: false, performed: false, message: 'AI analysis is currently unavailable.' };
  }

  const ocr = await ocrService.extractFields(filePath, mimetype);
  if (ocr.status !== 'completed') {
    // Real OCR failure: no AI call is made and no score is invented.
    return {
      available: false,
      performed: false,
      message: 'Unable to extract sufficient text from this document, so AI analysis was not performed.',
    };
  }

  try {
    const result = await aiService.analyzeDocument({
      ocrText: ocr.text,
      filePath,
      mimetype,
      certificateId: certificateId || (certRow && certRow.certificate_id),
    });

    if (persistForId) {
      await query(
        `INSERT INTO ai_analyses (certificate_id, document_path, risk_score, classification, findings, provider, model, analysis_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
        [
          persistForId,
          certRow ? certRow.document_path : null,
          result.riskScore,
          result.classification,
          JSON.stringify({ checks: result.checks, findings: result.findings }),
          result.provider,
          result.model,
        ]
      );
    }

    return {
      available: true,
      performed: true,
      riskScore: result.riskScore,
      classification: result.classification,
      checks: result.checks,
      findings: result.findings,
      provider: result.provider,
      model: result.model,
      message: `AI risk score: ${result.riskScore}/100 (${result.classification}).`,
    };
  } catch (err) {
    if (persistForId) {
      try {
        await query(
          `INSERT INTO ai_analyses (certificate_id, document_path, provider, model, analysis_status, unavailable_reason)
           VALUES ($1, $2, $3, $4, 'unavailable', $5)`,
          [
            persistForId,
            certRow ? certRow.document_path : null,
            process.env.AI_MODEL || 'unknown',
            process.env.AI_API_KEY ? 'provider-error' : 'not-configured',
            err.message || 'AI analysis is currently unavailable.',
          ]
        );
      } catch (_) {
        /* history write must not break the verification response */
      }
    }
    return { available: false, performed: false, message: 'AI analysis is currently unavailable.' };
  }
}

/* ------------------------------------------------------------------ */
/* 8. generateFinalResult                                              */
/* ------------------------------------------------------------------ */
function generateFinalResult({ found, revocation, hashCheck, issuerCheck, chain, ai }) {
  if (!found) return 'NOT_FOUND';
  if (revocation.revoked) return 'REVOKED';
  if (hashCheck && hashCheck.performed && hashCheck.match === false) return 'TAMPERED';

  const problems = [];
  const recordFound = chain.recordFound !== undefined ? chain.recordFound : Boolean(chain.record);
  if (!chain.available) problems.push('blockchain state unavailable');
  else if (chain.required && !recordFound) problems.push('no blockchain record found');
  else if (chain.required && chain.hashMatch === false) problems.push('document hash does not match the blockchain record');
  if (issuerCheck && !issuerCheck.verified) problems.push('issuer not fully verified');
  if (ai && ai.available && typeof ai.riskScore === 'number' && ai.riskScore >= aiService.HIGH_THRESHOLD()) {
    problems.push('high AI risk score');
  }
  if (problems.length > 0) return 'SUSPICIOUS';
  return 'VERIFIED';
}

/* ------------------------------------------------------------------ */
/* 9. saveVerificationHistory - only real verification events          */
/* ------------------------------------------------------------------ */
async function saveVerificationHistory(row) {
  const result = await query(
    `INSERT INTO verifications
       (certificate_id, certificate_ref, verifier_id, verification_method, uploaded_document_hash,
        blockchain_hash, blockchain_status, hash_match, issuer_verified, revocation_status,
        ai_result, ai_risk_score, final_result, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id, created_at`,
    [
      row.certificate_id ?? null,
      row.certificate_ref,
      row.verifier_id ?? null,
      row.verification_method,
      row.uploaded_document_hash ?? null,
      row.blockchain_hash ?? null,
      row.blockchain_status ?? null,
      row.hash_match ?? null,
      row.issuer_verified ?? null,
      row.revocation_status ?? null,
      row.ai_result ?? null,
      row.ai_risk_score ?? null,
      row.final_result,
      JSON.stringify(row.details || {}),
    ]
  );
  return result.rows[0];
}

/* ================================================================== */
/* Orchestrators                                                       */
/* ================================================================== */

function publicCertificateView(certRow) {
  return {
    certificateId: certRow.certificate_id,
    institution: certRow.institution_name,
    credential: certRow.degree,
    department: certRow.department,
    certificateType: certRow.certificate_type,
    academicYear: certRow.academic_year,
    issueDate: certRow.issue_date,
    expiryDate: certRow.expiry_date,
    status: certRow.status,
    documentFilename: certRow.document_filename,
  };
}

function technicalView(certRow, chain) {
  return {
    documentSha256: certRow.document_hash || 'Not available',
    blockchainTxHash: certRow.blockchain_tx_hash || 'Not available',
    blockNumber: certRow.block_number != null ? String(certRow.block_number) : 'Not available',
    contractAddress: process.env.CONTRACT_ADDRESS || 'Not available',
    issuerWallet: (chain && chain.record && chain.record.issuer) || certRow.institution_wallet || 'Not available',
    network: process.env.BLOCKCHAIN_RPC_URL || 'Not available',
    registeredAt: chain && chain.record && chain.record.timestampIso ? chain.record.timestampIso : 'Not available',
    blockchainStatus: certRow.blockchain_status || 'Not available',
  };
}

/**
 * Verification by certificate ID (or QR, which resolves to an ID).
 * documentChecked is false: we never claim a physical document was inspected.
 */
async function verifyById({ certificateId, verifierId = null, method = 'CERTIFICATE_ID' }) {
  const certRow = await findCertificate(certificateId);

  if (!certRow) {
    const verification = await saveVerificationHistory({
      certificate_id: null,
      certificate_ref: certificateId,
      verifier_id: verifierId,
      verification_method: method,
      blockchain_status: 'not_found',
      final_result: 'NOT_FOUND',
      details: { message: 'No certificate with this ID exists in the database.' },
    });
    return {
      finalResult: 'NOT_FOUND',
      documentChecked: false,
      verificationId: verification.id,
      verifiedAt: verification.created_at,
      certificate: null,
      message: 'Certificate Not Found.',
      note: 'No certificate with this identifier has been issued through this system.',
      blockchain: { available: false, required: false, message: 'Not checked - certificate record not found.' },
      hash: { performed: false, message: 'No document was uploaded, so no hash comparison was performed.' },
      issuer: null,
      revocation: { revoked: false, message: 'Not applicable - certificate not found.' },
      ai: { available: false, performed: false, message: 'AI analysis has not been performed.' },
      technical: null,
    };
  }

  const chain = await getBlockchainRecord(certificateId);
  const revocation = await checkRevocation(certRow, chain.record);
  const issuerCheck = checkIssuer(certRow, chain.record);

  const chainInfo = {
    available: chain.available,
    required: true,
    recordFound: Boolean(chain.record),
    hashMatch: null, // no document provided in an ID/QR lookup
    hash: chain.record ? chain.record.certificateHash : null,
    issuer: chain.record ? chain.record.issuer : null,
    timestampIso: chain.record ? chain.record.timestampIso : null,
    message: chain.available
      ? chain.record
        ? 'Blockchain record found.'
        : 'No blockchain record exists for this certificate.'
      : chain.error,
  };

  const ai = { available: false, performed: false, message: 'AI analysis has not been performed because no document was provided.' };

  const finalResult = generateFinalResult({
    found: true,
    revocation,
    hashCheck: null,
    issuerCheck,
    chain: chainInfo,
    ai,
  });

  const verification = await saveVerificationHistory({
    certificate_id: certRow.id,
    certificate_ref: certRow.certificate_id,
    verifier_id: verifierId,
    verification_method: method,
    blockchain_hash: chainInfo.hash,
    blockchain_status: chain.available ? (chain.record ? 'record_found' : 'record_missing') : 'unavailable',
    issuer_verified: issuerCheck.verified,
    revocation_status: revocation.revoked ? 'REVOKED' : 'ACTIVE',
    ai_result: 'not_performed',
    final_result: finalResult,
    details: {
      documentChecked: false,
      chainMessage: chainInfo.message,
      issuerMessage: issuerCheck.message,
      note: PUBLIC_MESSAGE,
    },
  });

  return {
    finalResult,
    documentChecked: false,
    verificationId: verification.id,
    verifiedAt: verification.created_at,
    certificate: publicCertificateView(certRow),
    message: buildMessage(finalResult),
    note:
      finalResult === 'VERIFIED'
        ? 'No document was uploaded, so the physical file was not hash-checked. ' + PUBLIC_MESSAGE
        : 'No document was uploaded, so the physical file was not hash-checked.',
    blockchain: chainInfo,
    hash: { performed: false, message: 'No document was uploaded, so no hash comparison was performed.' },
    issuer: issuerCheck,
    revocation,
    ai,
    technical: technicalView(certRow, chain),
    riskSummary: null,
  };
}

/**
 * Verification by uploaded document: real OCR, real SHA-256, compared against
 * the real blockchain record.
 */
async function verifyUpload({ filePath, mimetype, verifierId = null, method = 'UPLOAD', requestedCertificateId = null }) {
  const uploadedHash = await hashService.hashFile(filePath);

  // Locate the certificate: by explicit ID when supplied, otherwise by
  // matching the real document hash against stored records.
  let certRow = null;
  if (requestedCertificateId) {
    certRow = await findCertificate(requestedCertificateId);
  }
  if (!certRow) {
    const byHash = await query(
      `SELECT c.*, i.name AS institution_name, i.verification_status AS institution_status,
              i.wallet_address AS institution_wallet
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE LOWER(c.document_hash) = LOWER($1)
        ORDER BY c.created_at DESC LIMIT 1`,
      [uploadedHash]
    );
    certRow = byHash.rows[0] || null;
  }

  if (!certRow) {
    const verification = await saveVerificationHistory({
      certificate_id: null,
      certificate_ref: requestedCertificateId || `upload:${uploadedHash.slice(0, 16)}`,
      verifier_id: verifierId,
      verification_method: method,
      uploaded_document_hash: uploadedHash,
      blockchain_status: 'not_found',
      final_result: 'NOT_FOUND',
      details: { documentChecked: true, message: 'No certificate record matches this document.' },
    });
    fs.promises.unlink(filePath).catch(() => {});
    return {
      finalResult: 'NOT_FOUND',
      documentChecked: true,
      uploadedHash,
      verificationId: verification.id,
      verifiedAt: verification.created_at,
      certificate: null,
      message: 'Certificate Not Found.',
      note: 'This document does not correspond to any certificate issued through this system.',
      blockchain: { available: false, required: false, message: 'Not checked - no certificate record matches this document.' },
      hash: { performed: true, uploadedHash, storedHash: null, match: false, message: 'No stored fingerprint matches this document.' },
      issuer: null,
      revocation: { revoked: false, message: 'Not applicable - certificate not found.' },
      ai: { available: false, performed: false, message: 'AI analysis has not been performed.' },
      technical: null,
    };
  }

  const chain = await getBlockchainRecord(certRow.certificate_id);
  const revocation = await checkRevocation(certRow, chain.record);

  // Compare the uploaded fingerprint against the authoritative chain record.
  const referenceHash = chain.record ? chain.record.certificateHash : certRow.document_hash;
  const match = hashService.hashesEqual(uploadedHash, referenceHash);
  const hashCheck = { performed: true, uploadedHash, storedHash: referenceHash, match };

  const issuerCheck = checkIssuer(certRow, chain.record);
  const ai = await runAIAnalysis({
    certRow,
    filePath,
    mimetype,
    certificateId: certRow.certificate_id,
    persistForId: certRow.id,
  });

  fs.promises.unlink(filePath).catch(() => {});

  const chainInfo = {
    available: chain.available,
    required: true,
    recordFound: Boolean(chain.record),
    hashMatch: chain.record ? match : null,
    hash: chain.record ? chain.record.certificateHash : null,
    issuer: chain.record ? chain.record.issuer : null,
    timestampIso: chain.record ? chain.record.timestampIso : null,
    message: chain.available
      ? chain.record
        ? 'Blockchain record found.'
        : 'No blockchain record exists for this certificate.'
      : chain.error,
  };

  const finalResult = generateFinalResult({
    found: true,
    revocation,
    hashCheck,
    issuerCheck,
    chain: chainInfo,
    ai,
  });

  const aiResultText = ai.performed ? `${ai.classification} (${ai.riskScore})` : 'unavailable';

  const verification = await saveVerificationHistory({
    certificate_id: certRow.id,
    certificate_ref: certRow.certificate_id,
    verifier_id: verifierId,
    verification_method: method,
    uploaded_document_hash: uploadedHash,
    blockchain_hash: chainInfo.hash,
    blockchain_status: chain.available ? (chain.record ? 'record_found' : 'record_missing') : 'unavailable',
    hash_match: match,
    issuer_verified: issuerCheck.verified,
    revocation_status: revocation.revoked ? 'REVOKED' : 'ACTIVE',
    ai_result: aiResultText,
    ai_risk_score: ai.performed ? ai.riskScore : null,
    final_result: finalResult,
    details: {
      documentChecked: true,
      chainMessage: chainInfo.message,
      issuerMessage: issuerCheck.message,
      aiMessage: ai.message,
      hashMessage: match ? 'Document fingerprint matches the registered record.' : 'Document fingerprint does not match the registered record.',
    },
  });

  return {
    finalResult,
    documentChecked: true,
    uploadedHash,
    verificationId: verification.id,
    verifiedAt: verification.created_at,
    certificate: publicCertificateView(certRow),
    message: buildMessage(finalResult),
    blockchain: chainInfo,
    hash: {
      performed: true,
      uploadedHash,
      storedHash: referenceHash,
      match,
      message: match
        ? 'Document fingerprint matches the registered record.'
        : 'Document fingerprint does not match the registered record.',
    },
    issuer: issuerCheck,
    revocation,
    ai,
    technical: technicalView(certRow, chain),
    riskSummary: ai.performed ? aiService.classifyScore(ai.riskScore) : null,
  };
}

function buildMessage(finalResult) {
  switch (finalResult) {
    case 'VERIFIED':
      return 'This certificate matches the officially registered blockchain record.';
    case 'TAMPERED':
      return 'This uploaded document does not match the officially registered certificate fingerprint.';
    case 'REVOKED':
      return 'The blockchain record has not been deleted. The certificate status has been changed to revoked.';
    case 'SUSPICIOUS':
      return 'This verification requires review. Please contact the issuing institution.';
    default:
      return 'Certificate Not Found.';
  }
}

module.exports = {
  findCertificate,
  getBlockchainRecord,
  calculateHash,
  compareHash,
  checkIssuer,
  checkRevocation,
  runAIAnalysis,
  generateFinalResult,
  saveVerificationHistory,
  verifyById,
  verifyUpload,
  publicCertificateView,
  technicalView,
  buildMessage,
  PUBLIC_MESSAGE,
};
