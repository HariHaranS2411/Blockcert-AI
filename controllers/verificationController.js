'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const verificationService = require('../services/verificationService');
const { deleteStoredFile, resolveStoredPath } = require('../utils/fileUtils');
const { optionalAuth } = require('../middleware/authMiddleware');
const certService = require('../services/certificateService');

/** POST /api/verification/id - public (no login required) */
async function verifyById(req, res, next) {
  try {
    const certificateId = String(req.body.certificateId || '').trim().toUpperCase();
    if (!/^CERT-\d{4}-\d{6}$/.test(certificateId)) {
      return res.status(400).json({ success: false, message: 'Certificate ID must use the format CERT-YYYY-XXXXXX.' });
    }
    const result = await verificationService.verifyById({
      certificateId,
      verifierId: req.user ? req.user.id : null,
      method: 'CERTIFICATE_ID',
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/verification/upload - public document upload verification */
async function verifyUpload(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'A certificate document (PDF/PNG/JPG) is required.' });
    }
    const requestedCertificateId = req.body.certificateId ? String(req.body.certificateId).trim().toUpperCase() : null;
    if (requestedCertificateId && !/^CERT-\d{4}-\d{6}$/.test(requestedCertificateId)) {
      deleteStoredFile(path.basename(req.file.path));
      return res.status(400).json({ success: false, message: 'Certificate ID must use the format CERT-YYYY-XXXXXX.' });
    }

    const result = await verificationService.verifyUpload({
      filePath: req.file.path,
      mimetype: req.file.mimetype,
      verifierId: req.user ? req.user.id : null,
      method: 'UPLOAD',
      requestedCertificateId,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    if (req.file) deleteStoredFile(path.basename(req.file.path));
    return next(err);
  }
}

/** POST /api/verification/qr - decodes a scanned QR URL, then verifies by ID */
async function verifyQr(req, res, next) {
  try {
    const raw = String(req.body.qrData || req.body.qr || '').trim();
    if (!raw) {
      return res.status(400).json({ success: false, message: 'QR data is required.' });
    }

    let certificateId = null;
    if (/^CERT-\d{4}-\d{6}$/.test(raw)) {
      certificateId = raw;
    } else {
      try {
        const url = new URL(raw);
        certificateId = url.searchParams.get('id');
      } catch (_) {
        return res.status(400).json({ success: false, message: 'The scanned QR does not contain a valid BlockCert verification link.' });
      }
    }

    if (!certificateId || !/^CERT-\d{4}-\d{6}$/.test(certificateId)) {
      return res.status(400).json({ success: false, message: 'The scanned QR does not contain a valid BlockCert verification link.' });
    }

    const result = await verificationService.verifyById({
      certificateId,
      verifierId: req.user ? req.user.id : null,
      method: 'QR',
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/verification/:id - a stored verification record (public-safe subset) */
async function getVerification(req, res, next) {
  try {
    const id = Number(req.params.id);
    const result = await query(
      `SELECT v.*, c.certificate_id AS cert_id, c.status AS cert_status, i.name AS institution_name
         FROM verifications v
         LEFT JOIN certificates c ON c.id = v.certificate_id
         LEFT JOIN institutions i ON i.id = c.institution_id
        WHERE v.id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'Verification record not found.' });

    // Only the verifier, the owning institution, or an admin may view details.
    const isPrivileged =
      (req.user && row.verifier_id && Number(row.verifier_id) === Number(req.user.id)) ||
      (req.user && req.user.role === 'ADMIN') ||
      (req.user && req.user.role === 'INSTITUTION' && Number(req.user.institutionId) === Number(row.institution_id));

    const base = {
      id: row.id,
      certificateRef: row.certificate_ref,
      verificationMethod: row.verification_method,
      finalResult: row.final_result,
      hashMatch: row.hash_match,
      revocationStatus: row.revocation_status,
      aiResult: row.ai_result,
      createdAt: row.created_at,
      certificate: row.cert_id
        ? { certificateId: row.cert_id, institution: row.institution_name, status: row.cert_status }
        : null,
    };

    if (!isPrivileged) {
      return res.json({ success: true, data: { verification: base, restricted: true } });
    }

    return res.json({
      success: true,
      data: {
        verification: {
          ...base,
          verifierId: row.verifier_id,
          uploadedDocumentHash: row.uploaded_document_hash,
          blockchainHash: row.blockchain_hash,
          blockchainStatus: row.blockchain_status,
          issuerVerified: row.issuer_verified,
          aiRiskScore: row.ai_risk_score,
          details: row.details,
        },
        restricted: false,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/verification/history - real verification events for the caller */
async function history(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];

    if (req.user.role === 'ADMIN') {
      /* all verifications */
    } else if (req.user.role === 'INSTITUTION') {
      params.push(req.user.institutionId);
      where.push(`c.institution_id = $${params.length}`);
    } else {
      params.push(req.user.id);
      where.push(`v.verifier_id = $${params.length}`);
    }

    if (req.query.result) {
      params.push(req.query.result);
      where.push(`v.final_result = $${params.length}`);
    }
    if (req.query.certificateId) {
      params.push(`%${String(req.query.certificateId).trim()}%`);
      where.push(`v.certificate_ref ILIKE $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM verifications v
         LEFT JOIN certificates c ON c.id = v.certificate_id ${whereSql}`,
      params
    );

    params.push(limit, offset);
    const rows = await query(
      `SELECT v.id, v.certificate_ref, v.verification_method, v.hash_match, v.blockchain_status,
              v.issuer_verified, v.revocation_status, v.ai_result, v.ai_risk_score, v.final_result,
              v.created_at, c.certificate_id AS cert_id, c.status AS cert_status, i.name AS institution_name,
              u.name AS verifier_name, u.role AS verifier_role
         FROM verifications v
         LEFT JOIN certificates c ON c.id = v.certificate_id
         LEFT JOIN institutions i ON i.id = c.institution_id
         LEFT JOIN users u ON u.id = v.verifier_id
         ${whereSql}
        ORDER BY v.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const summary = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE final_result = 'VERIFIED')::int AS verified,
              COUNT(*) FILTER (WHERE final_result = 'SUSPICIOUS')::int AS suspicious,
              COUNT(*) FILTER (WHERE final_result = 'TAMPERED')::int AS tampered,
              COUNT(*) FILTER (WHERE final_result = 'REVOKED')::int AS revoked,
              COUNT(*) FILTER (WHERE final_result = 'NOT_FOUND')::int AS notFound
         FROM verifications v LEFT JOIN certificates c ON c.id = v.certificate_id
         ${whereSql.replace(/v\.certificate_ref/g, 'v.certificate_ref')}`,
      params.slice(0, params.length - 2)
    );

    return res.json({
      success: true,
      data: {
        history: rows.rows.map((r) => ({
          id: r.id,
          certificateRef: r.cert_id || r.certificate_ref,
          institution: r.institution_name,
          method: r.verification_method,
          hashMatch: r.hash_match,
          blockchainStatus: r.blockchain_status,
          issuerVerified: r.issuer_verified,
          revocationStatus: r.revocation_status,
          aiResult: r.ai_result,
          aiRiskScore: r.ai_risk_score,
          finalResult: r.final_result,
          verifier: r.verifier_name ? `${r.verifier_name} (${r.verifier_role})` : 'Public',
          createdAt: r.created_at,
        })),
        summary: summary.rows[0],
        pagination: { page, limit, total: countResult.rows[0].total, pages: Math.ceil(countResult.rows[0].total / limit) },
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/verification/bulk - CSV of certificate IDs, real per-row results */
async function bulkVerify(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'A CSV file with certificate IDs is required.' });
    }

    const csv = fs.readFileSync(req.file.path, 'utf8');
    deleteStoredFile(path.basename(req.file.path));

    const ids = extractIds(csv);
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No certificate IDs were found in the CSV.' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ success: false, message: 'Bulk verification is limited to 200 rows per file.' });
    }

    const results = [];
    const summary = { VERIFIED: 0, SUSPICIOUS: 0, TAMPERED: 0, REVOKED: 0, NOT_FOUND: 0 };

    for (const entry of ids) {
      try {
        const result = await verificationService.verifyById({
          certificateId: entry.certificateId,
          verifierId: req.user ? req.user.id : null,
          method: 'BULK',
        });
        summary[result.finalResult] += 1;
        results.push({
          row: entry.row,
          certificateId: entry.certificateId,
          finalResult: result.finalResult,
          institution: result.certificate ? result.certificate.institution : null,
          status: result.certificate ? result.certificate.status : null,
          blockchainAvailable: result.blockchain.available,
          blockchainRecordFound: result.blockchain.recordFound,
          message: result.message,
        });
      } catch (err) {
        summary.NOT_FOUND += 1;
        results.push({
          row: entry.row,
          certificateId: entry.certificateId,
          finalResult: 'ERROR',
          message: err.message || 'Verification failed.',
        });
      }
    }

    await certService.auditLog(req.user ? req.user.id : null, 'verification.bulk', 'verification', null, {
      total: ids.length,
      summary,
    });

    return res.json({
      success: true,
      message: `Bulk verification complete: ${summary.VERIFIED} verified, ${summary.SUSPICIOUS} suspicious, ${summary.TAMPERED} tampered, ${summary.REVOKED} revoked, ${summary.NOT_FOUND} not found.`,
      data: { total: ids.length, summary, results },
    });
  } catch (err) {
    return next(err);
  }
}

function extractIds(csv) {
  const out = [];
  const seen = new Set();
  const lines = csv.replace(/\r/g, '').split('\n');
  let rowNumber = 0;
  for (const line of lines) {
    rowNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Take the first column of each row.
    const firstCell = trimmed.split(',')[0].replace(/^"|"$/g, '').trim();
    if (!firstCell) continue;
    if (rowNumber === 1 && /certificate/i.test(firstCell)) continue; // header
    const match = firstCell.toUpperCase().match(/CERT-\d{4}-\d{6}/);
    if (!match) continue;
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    out.push({ row: rowNumber, certificateId: match[0] });
  }
  return out;
}

module.exports = { verifyById, verifyUpload, verifyQr, getVerification, history, bulkVerify };
