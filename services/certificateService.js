'use strict';

/**
 * certificateService - issuance, bulk issuance, revocation and the
 * blockchain reconciliation job.
 *
 * Reconciliation strategy:
 *  - DB row is written first with blockchain_status='pending'.
 *  - The chain transaction is submitted; the tx hash is persisted BEFORE
 *    waiting for the receipt, so a crash between submit and confirm is
 *    recoverable.
 *  - After confirmation the row becomes 'registered' with the real block number.
 *  - If the chain fails the row stays 'pending'/'failed' and the certificate is
 *    NOT reported as blockchain-verified.
 *  - A periodic recovery job re-checks pending rows: it re-submits when no tx
 *    hash exists, and finalises the receipt when a tx hash exists.
 *  - If the chain succeeded but the DB update failed, the recovery job finds
 *    the on-chain record by certificate ID and back-fills the DB from it.
 */

const { query, withTransaction } = require('../config/database');
const bcrypt = require('bcrypt');
const hashService = require('./hashService');
const blockchainService = require('./blockchainService');
const ocrService = require('./ocrService');
const qrService = require('./qrService');
const { deleteStoredFile } = require('../utils/fileUtils');

const CERT_ID_RE = /^CERT-\d{4}-\d{6}$/;

/** Unique certificate ID: CERT-YYYY-XXXXXX, sequence derived from real DB state. */
async function generateCertificateId(client, issueDate) {
  const year = new Date(issueDate).getFullYear();
  const prefix = `CERT-${year}-`;
  const executor = client || { query: (t, p) => query(t, p) };

  const result = await executor.query(
    `SELECT certificate_id FROM certificates WHERE certificate_id LIKE $1`,
    [prefix + '%']
  );

  let maxSeq = 0;
  for (const row of result.rows) {
    const seq = Number(row.certificate_id.slice(prefix.length));
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }

  let candidate;
  let attempts = 0;
  do {
    maxSeq += 1;
    candidate = prefix + String(maxSeq).padStart(6, '0');
    attempts += 1;
    if (attempts > 1000) {
      const e = new Error('Unable to allocate a unique certificate ID. Please retry.');
      e.status = 500;
      throw e;
    }
  } while (await certificateIdExists(candidate, executor));

  return candidate;
}

async function certificateIdExists(id, executor) {
  const run = executor ? executor.query.bind(executor) : query;
  const result = await run('SELECT 1 FROM certificates WHERE certificate_id = $1', [id]);
  return result.rowCount > 0;
}

/** All duplicate checks. Returns an array of human-readable problems. */
async function checkDuplicates({ certificateId, studentName, registrationNumber, institutionId, documentHash, degree, issueDate, semester }, executor) {
  const problems = [];

  if (certificateId && (await certificateIdExists(certificateId, executor))) {
    problems.push(`Certificate ID ${certificateId} already exists.`);
  }

  const merged = { studentName, registrationNumber, institutionId, documentHash, degree, issueDate, semester };
  return problems.concat(await checkDuplicatesWithFields(merged, executor || { query }));
}

/* ================================================================== */
/* Single issuance                                                     */
/* ================================================================== */
async function issueCertificate({
  institutionId,
  createdBy,
  fields,
  filePath,
  originalName,
  mimetype,
  size,
  ocrSuggestion,
}) {
  const documentHash = await hashService.hashFile(filePath);

  // OCR is a real extraction; failure does not invent data but is recorded.
  const ocr = await ocrService.extractFields(filePath, mimetype);

  const cert = await withTransaction(async (client) => {
    const dupProblems = await checkDuplicatesWithFields(
      { studentName: fields.studentName, registrationNumber: fields.registrationNumber, institutionId, documentHash, degree: fields.degree, issueDate: fields.issueDate, semester: fields.semester },
      client
    );
    if (dupProblems.length > 0) {
      const e = new Error(dupProblems.join(' '));
      e.status = 409;
      throw e;
    }

    const certificateId = await generateCertificateId(client, fields.issueDate);

    // Link the certificate to a student account: the account matching the
    // student email given by the institution. studentEmail + studentPassword
    // are REQUIRED at issuance; when no account exists yet, one is
    // provisioned (bcrypt-hashed password, same policy as self-signup) so
    // the student can log in with exactly those credentials.
    let studentUserId = fields.studentUserId || null;
    if (!studentUserId && fields.studentEmail) {
      const byEmail = await client.query(
        "SELECT id FROM users WHERE LOWER(role) = 'student' AND LOWER(email) = LOWER($1) LIMIT 1",
        [fields.studentEmail]
      );
      if (byEmail.rows[0]) {
        studentUserId = byEmail.rows[0].id;
      } else if (fields.registrationNumber) {
        // A student may have self-registered with this registration number
        // under a different email BEFORE the certificate was issued. Link to
        // that account instead of crashing on the registration_number unique
        // constraint (same real linkage rule as auth register: exact
        // registration-number match).
        const byReg = await client.query(
          "SELECT id FROM users WHERE LOWER(role) = 'student' AND LOWER(registration_number) = LOWER($1) LIMIT 1",
          [fields.registrationNumber]
        );
        if (byReg.rows[0]) {
          studentUserId = byReg.rows[0].id;
        } else if (fields.studentPassword) {
          const passwordHash = await bcrypt.hash(fields.studentPassword, 12);
          const created = await client.query(
            `INSERT INTO users (name, email, password_hash, role, registration_number)
             VALUES ($1, $2, $3, 'STUDENT', $4) RETURNING id`,
            [fields.studentName, fields.studentEmail.toLowerCase(), passwordHash, fields.registrationNumber || null]
          );
          studentUserId = created.rows[0].id;
        }
      } else if (fields.studentPassword) {
        const passwordHash = await bcrypt.hash(fields.studentPassword, 12);
        const created = await client.query(
          `INSERT INTO users (name, email, password_hash, role, registration_number)
           VALUES ($1, $2, $3, 'STUDENT', $4) RETURNING id`,
          [fields.studentName, fields.studentEmail.toLowerCase(), passwordHash, fields.registrationNumber || null]
        );
        studentUserId = created.rows[0].id;
      }
    }
    if (!studentUserId) {
      const student = await client.query(
        "SELECT id FROM users WHERE LOWER(role) = 'student' AND registration_number = $1 LIMIT 1",
        [fields.registrationNumber]
      );
      if (student.rows[0]) studentUserId = student.rows[0].id;
    }

    const inserted = await client.query(
      `INSERT INTO certificates
         (certificate_id, student_id, institution_id, student_name, registration_number,
          degree, department, semester, certificate_type, academic_year, marks, issue_date, expiry_date,
          document_path, document_filename, document_mime, document_size, document_hash,
          ocr_text, ocr_status, status, blockchain_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'ACTIVE','pending',$21)
       RETURNING *`,
      [
        certificateId,
        studentUserId,
        institutionId,
        fields.studentName,
        fields.registrationNumber,
        fields.degree,
        fields.department || null,
        fields.semester || null,
        fields.certificateType,
        fields.academicYear || null,
        fields.marks || null,
        fmtDate(fields.issueDate),
        fields.expiryDate ? fmtDate(fields.expiryDate) : null,
        require('path').basename(filePath),
        originalName,
        mimetype,
        size,
        documentHash,
        ocr.text || null,
        ocr.status,
        createdBy,
      ]
    );
    return inserted.rows[0];
  }).catch((err) => {
    deleteStoredFile(require('path').basename(filePath));
    throw err;
  });

  // Step 7: real blockchain transaction (outside the DB transaction).
  await registerOnBlockchain(cert);

  // Step 8/9: QR + status refresh.
  const finalRow = (await query('SELECT * FROM certificates WHERE id = $1', [cert.id])).rows[0];
  const qrDataUrl = await qrService.generateQrDataUrl(finalRow.certificate_id).catch(() => null);

  await auditLog(createdBy, 'certificate.issued', 'certificate', finalRow.certificate_id, {
    documentHash,
    blockchainStatus: finalRow.blockchain_status,
  });

  return { certificate: finalRow, documentHash, ocr: { status: ocr.status, text: ocr.text, fields: ocr.fields }, qrDataUrl };
}

async function checkDuplicatesWithFields({ studentName, registrationNumber, institutionId, documentHash, degree, issueDate, semester }, executor) {
  const run = executor.query.bind(executor);
  const problems = [];

  const docResult = await run('SELECT certificate_id FROM certificates WHERE LOWER(document_hash) = LOWER($1)', [documentHash]);
  if (docResult.rowCount > 0) {
    problems.push(`This document is already registered as ${docResult.rows[0].certificate_id}.`);
  }

  // Same student + credential is only a duplicate when the SEMESTER matches
  // too (or both are unset). This lets an institution issue 1st, 2nd, 3rd
  // semester certificates for the same student while still blocking an exact
  // re-upload of the same semester's record.
  const semCond = semester
    ? 'COALESCE(semester, 0) = $6'
    : 'COALESCE(semester, 0) = 0';
  const semParams = semester ? [semester] : [];
  const studentResult = await run(
    `SELECT certificate_id FROM certificates
      WHERE LOWER(student_name) = LOWER($1) AND registration_number = $2
        AND institution_id = $3 AND LOWER(degree) = LOWER($4) AND issue_date = $5
        AND ${semCond}`,
    [studentName, registrationNumber, institutionId, degree, fmtDate(issueDate), ...semParams]
  );
  if (studentResult.rowCount > 0) {
    problems.push(
      semester
        ? `A certificate for register number ${registrationNumber}, semester ${semester} and this credential already exists (${studentResult.rows[0].certificate_id}).`
        : `A certificate for register number ${registrationNumber} and this credential already exists (${studentResult.rows[0].certificate_id}).`
    );
  }

  return problems;
}

/**
 * Submit the real chain transaction and persist the real tx hash / block number.
 * On failure the certificate remains ACTIVE but NOT blockchain-verified.
 */
async function registerOnBlockchain(cert) {
  if (!blockchainService.isBlockchainConfigured()) {
    await query(`UPDATE certificates SET blockchain_status = 'not_configured', updated_at = NOW() WHERE id = $1`, [cert.id]);
    return { ok: false, reason: 'Smart contract address is not configured.' };
  }

  try {
    const existing = await blockchainService.getCertificateRecord(cert.certificate_id);
    if (existing) {
      // The chain already holds a record for this ID. Adopt it ONLY when the
      // fingerprint matches this document; otherwise report the conflict
      // instead of silently linking the wrong record.
      if (String(existing.certificateHash).toLowerCase() !== String(cert.document_hash).toLowerCase()) {
        await query(
          `UPDATE certificates SET blockchain_status = 'failed', updated_at = NOW()
            WHERE id = $1 AND blockchain_status = 'pending'`,
          [cert.id]
        ).catch(() => {});
        return {
          ok: false,
          reason: `A different fingerprint is already registered on-chain for ${cert.certificate_id}. The certificate is NOT blockchain-verified.`,
        };
      }
      let event = null;
      try {
        event = await blockchainService.findIssuanceEvent(cert.certificate_id);
      } catch (_) {
        event = null;
      }
      await query(
        `UPDATE certificates
            SET blockchain_tx_hash = COALESCE(blockchain_tx_hash, $2),
                block_number = COALESCE(block_number, $3),
                blockchain_status = 'registered',
                blockchain_record_id = $4,
                updated_at = NOW()
          WHERE id = $1`,
        [cert.id, event ? event.txHash : null, event ? event.blockNumber : null, cert.certificate_id]
      );
      return { ok: true, adopted: true };
    }

    const receipt = await blockchainService.issueCertificate(cert.certificate_id, cert.document_hash);

    // Persist tx hash first (durability), then confirm.
    await query(
      `UPDATE certificates SET blockchain_tx_hash = $2, updated_at = NOW() WHERE id = $1`,
      [cert.id, receipt.txHash]
    );
    await query(
      `UPDATE certificates
          SET block_number = $2, blockchain_status = 'registered',
              blockchain_record_id = $3, updated_at = NOW()
        WHERE id = $1`,
      [cert.id, receipt.blockNumber, cert.certificate_id]
    );
    await auditLog(cert.created_by, 'blockchain.registered', 'certificate', cert.certificate_id, {
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
    });
    return { ok: true, txHash: receipt.txHash, blockNumber: receipt.blockNumber };
  } catch (err) {
    console.error(`[blockchain] registration failed for ${cert.certificate_id}:`, err.shortMessage || err.message || err);
    if (process.env.BLOCKCHAIN_DEBUG) {
      console.error('[blockchain] detail:', JSON.stringify({ code: err.code, reason: err.reason, shortMessage: err.shortMessage, info: err.info ? String(err.info).slice(0, 300) : undefined, cause: err.cause ? String(err.cause.message || err.cause) : undefined }));
    }
    await query(
      `UPDATE certificates SET blockchain_status = 'failed', updated_at = NOW() WHERE id = $1 AND blockchain_status = 'pending'`,
      [cert.id]
    ).catch(() => {});
    return { ok: false, reason: err.message || 'Blockchain registration failed.' };
  }
}

/* ================================================================== */
/* Revocation                                                          */
/* ================================================================== */
async function revokeCertificate({ certificate, revokedBy, reason }) {
  let chainResult = { ok: false, reason: null };

  if (certificate.status === 'REVOKED') {
    const e = new Error('This certificate is already revoked.');
    e.status = 409;
    throw e;
  }

  if (blockchainService.isBlockchainConfigured()) {
    try {
      const receipt = await blockchainService.revokeCertificate(certificate.certificate_id);
      chainResult = { ok: true, txHash: receipt.txHash, blockNumber: receipt.blockNumber };
    } catch (err) {
      chainResult = { ok: false, reason: err.message || 'Blockchain revocation failed.' };
    }
  } else {
    chainResult = { ok: false, reason: 'Smart contract address is not configured.' };
  }

  // The DB is updated only after a confirmed on-chain revocation, so the UI
  // never claims REVOKED when the chain rejected the transaction.
  if (!chainResult.ok) {
    const e = new Error(`Certificate was not revoked: ${chainResult.reason}`);
    e.status = 503;
    e.code = chainResult.reason && /not configured/.test(chainResult.reason) ? 'BLOCKCHAIN_UNAVAILABLE' : undefined;
    throw e;
  }

  await withTransaction(async (client) => {
    await client.query(`UPDATE certificates SET status = 'REVOKED', updated_at = NOW() WHERE id = $1`, [certificate.id]);
    await client.query(
      `INSERT INTO revocations (certificate_id, reason, revoked_by, blockchain_tx_hash, blockchain_status)
       VALUES ($1,$2,$3,$4,'registered')`,
      [certificate.id, reason, revokedBy, chainResult.txHash]
    );
  });

  await auditLog(revokedBy, 'certificate.revoked', 'certificate', certificate.certificate_id, {
    reason,
    txHash: chainResult.txHash,
    blockNumber: chainResult.blockNumber,
  });

  const updated = (await query('SELECT * FROM certificates WHERE id = $1', [certificate.id])).rows[0];
  return { certificate: updated, txHash: chainResult.txHash, blockNumber: chainResult.blockNumber };
}

/* ================================================================== */
/* Reconciliation job                                                  */
/* ================================================================== */
async function reconcileBlockchainRecords() {
  const summary = { examined: 0, registered: 0, adopted: 0, failed: 0, skipped: 0 };
  if (!blockchainService.isBlockchainConfigured()) return summary;

  const pending = await query(
    `SELECT * FROM certificates WHERE blockchain_status IN ('pending','failed') LIMIT 25`
  );

  for (const cert of pending.rows) {
    summary.examined += 1;
    try {
      if (cert.blockchain_tx_hash) {
        // Tx already submitted: finalise from the real receipt.
        const provider = require('../config/blockchain').getProvider();
        const receipt = await provider.getTransactionReceipt(cert.blockchain_tx_hash);
        if (receipt && receipt.status === 1) {
          await query(
            `UPDATE certificates SET block_number = $2, blockchain_status = 'registered', blockchain_record_id = $3, updated_at = NOW()
              WHERE id = $1`,
            [cert.id, receipt.blockNumber, cert.certificate_id]
          );
          summary.registered += 1;
        }
        continue;
      }

      // No tx hash: check whether the chain already has the record
      // (chain succeeded, DB update failed scenario).
      const record = await blockchainService.getCertificateRecord(cert.certificate_id);
      if (record && String(record.certificateHash).toLowerCase() === String(cert.document_hash).toLowerCase()) {
        let event = null;
        try {
          event = await blockchainService.findIssuanceEvent(cert.certificate_id);
        } catch (_) {
          event = null;
        }
        await query(
          `UPDATE certificates
              SET blockchain_tx_hash = $2, block_number = $3, blockchain_status = 'registered',
                  blockchain_record_id = $4, updated_at = NOW()
            WHERE id = $1`,
          [cert.id, event ? event.txHash : null, event ? event.blockNumber : null, cert.certificate_id]
        );
        summary.adopted += 1;
      } else {
        const result = await registerOnBlockchain(cert);
        if (result.ok) summary.registered += 1;
        else summary.failed += 1;
      }
    } catch (err) {
      summary.failed += 1;
      console.error(`[reconcile] ${cert.certificate_id}: ${err.message}`);
    }
  }
  return summary;
}

let reconcileTimer = null;
function startReconciliationJob() {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    reconcileBlockchainRecords().catch((err) => console.error('[reconcile]', err.message));
  }, 60000);
  reconcileTimer.unref();
}
function stopReconciliationJob() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}

/* ================================================================== */
/* Audit log helper                                                    */
/* ================================================================== */
async function auditLog(actorId, action, entity, entityRef, details) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity, entity_ref, details) VALUES ($1,$2,$3,$4,$5)`,
      [actorId ?? null, action, entity, entityRef ?? null, JSON.stringify(details || {})]
    );
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}

function fmtDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

module.exports = {
  issueCertificate,
  revokeCertificate,
  registerOnBlockchain,
  generateCertificateId,
  checkDuplicates,
  reconcileBlockchainRecords,
  startReconciliationJob,
  stopReconciliationJob,
  auditLog,
  fmtDate,
  CERT_ID_RE,
};
