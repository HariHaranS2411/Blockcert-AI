'use strict';

const fs = require('fs');
const path = require('path');
const { query, withTransaction } = require('../config/database');
const certService = require('../services/certificateService');
const verificationService = require('../services/verificationService');
const qrService = require('../services/qrService');
const { deleteStoredFile, resolveStoredPath, fileExists } = require('../utils/fileUtils');
const { CERTIFICATE_TYPES } = require('../utils/validation');

function certSummary(row) {
  return {
    id: row.id,
    certificateId: row.certificate_id,
    studentName: row.student_name,
    registrationNumber: row.registration_number,
    degree: row.degree,
    department: row.department,
    semester: row.semester,
    certificateType: row.certificate_type,
    academicYear: row.academic_year,
    marks: row.marks,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    status: row.status,
    blockchainStatus: row.blockchain_status,
    blockchainTxHash: row.blockchain_tx_hash,
    blockNumber: row.block_number != null ? Number(row.block_number) : null,
    documentHash: row.document_hash,
    documentFilename: row.document_filename,
    institutionName: row.institution_name || undefined,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* POST /api/certificates - single issuance with OCR review data       */
/* ------------------------------------------------------------------ */
async function createCertificate(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'A certificate document (PDF/PNG/JPG) is required.' });
    }

    const institutionId = req.user.institutionId;
    if (!institutionId) {
      deleteStoredFile(path.basename(req.file.path));
      return res.status(403).json({ success: false, message: 'Only institution accounts can issue certificates.' });
    }

    const inst = await query('SELECT verification_status FROM institutions WHERE id = $1', [institutionId]);
    if (!inst.rows[0]) {
      deleteStoredFile(path.basename(req.file.path));
      return res.status(404).json({ success: false, message: 'Institution record not found.' });
    }
    if (inst.rows[0].verification_status === 'REJECTED' || inst.rows[0].verification_status === 'SUSPENDED') {
      deleteStoredFile(path.basename(req.file.path));
      return res.status(403).json({
        success: false,
        message: `Institution status is ${inst.rows[0].verification_status}. Certificates cannot be issued.`,
      });
    }

    const fields = {
      studentName: req.body.studentName,
      registrationNumber: req.body.registrationNumber,
      degree: req.body.degree,
      department: req.body.department || null,
      semester: req.body.semester ? Number(req.body.semester) : null,
      certificateType: req.body.certificateType,
      academicYear: req.body.academicYear || null,
      marks: req.body.marks || null,
      issueDate: req.body.issueDate,
      expiryDate: req.body.expiryDate || null,
      studentUserId: null,
      studentEmail: req.body.studentEmail || null,
      studentPassword: req.body.studentPassword || null,
    };

    const result = await certService.issueCertificate({
      institutionId,
      createdBy: req.user.id,
      fields,
      filePath: req.file.path,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });

    const chainRegistered = result.certificate.blockchain_status === 'registered';
    const message = chainRegistered
      ? `Certificate ${result.certificate.certificate_id} issued and registered on the blockchain.`
      : result.certificate.blockchain_status === 'not_configured'
        ? `Certificate ${result.certificate.certificate_id} saved. Blockchain registration is unavailable: smart contract address is not configured.`
        : `Certificate ${result.certificate.certificate_id} saved, but blockchain registration did not complete. The certificate is NOT blockchain-verified.`;

    return res.status(201).json({
      success: true,
      message,
      data: {
        certificate: certSummary(result.certificate),
        documentHash: result.documentHash,
        ocr: result.ocr,
        qrDataUrl: result.qrDataUrl,
        blockchain: {
          registered: chainRegistered,
          txHash: result.certificate.blockchain_tx_hash || null,
          blockNumber: result.certificate.block_number || null,
          status: result.certificate.blockchain_status,
        },
      },
    });
  } catch (err) {
    if (req.file && !err.status) deleteStoredFile(path.basename(req.file.path));
    return next(err);
  }
}

/* ------------------------------------------------------------------ */
/* GET /api/certificates - list with search / filters / paging         */
/* ------------------------------------------------------------------ */
async function listCertificates(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const q = (req.query.q || '').trim();
    const status = req.query.status;
    const type = req.query.type;

    const where = [];
    const params = [];

    // Scope by role: institutions see only their own, admins see all.
    if (req.user.role === 'INSTITUTION') {
      params.push(req.user.institutionId);
      where.push(`c.institution_id = $${params.length}`);
    } else if (req.user.role === 'ADMIN') {
      /* all */
    } else {
      return res.status(403).json({ success: false, message: 'You do not have permission to list certificates.' });
    }

    if (q) {
      // Public search fields only: certificate ID, institution, credential type.
      params.push(`%${q}%`);
      const n = params.length;
      where.push(`(c.certificate_id ILIKE $${n} OR i.name ILIKE $${n} OR c.certificate_type ILIKE $${n} OR c.degree ILIKE $${n})`);
    }
    if (status) {
      params.push(status);
      where.push(`c.status = $${params.length}`);
    }
    if (type) {
      params.push(type);
      where.push(`c.certificate_type = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM certificates c JOIN institutions i ON i.id = c.institution_id ${whereSql}`,
      params
    );
    const total = countResult.rows[0].total;

    params.push(limit, offset);
    const rows = await query(
      `SELECT c.*, i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
         ${whereSql}
        ORDER BY c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const stats = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
              COUNT(*) FILTER (WHERE status = 'REVOKED')::int AS revoked,
              COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended,
              COUNT(*) FILTER (WHERE blockchain_status = 'registered')::int AS registered
         FROM certificates c ${req.user.role === 'INSTITUTION' ? 'WHERE c.institution_id = $1' : ''}`,
      req.user.role === 'INSTITUTION' ? [req.user.institutionId] : []
    );

    return res.json({
      success: true,
      data: {
        certificates: rows.rows.map(certSummary),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        stats: stats.rows[0],
        certificateTypes: CERTIFICATE_TYPES,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/* ------------------------------------------------------------------ */
/* GET /api/certificates/:id - detail (authorized)                     */
/* ------------------------------------------------------------------ */
async function getCertificate(req, res, next) {
  try {
    const id = Number(req.params.id);
    const result = await query(
      `SELECT c.*, i.name AS institution_name, i.verification_status AS institution_status
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'Certificate not found.' });

    const isOwner =
      req.user.role === 'ADMIN' ||
      (req.user.role === 'INSTITUTION' && Number(row.institution_id) === Number(req.user.institutionId)) ||
      (req.user.role === 'STUDENT' && row.student_id != null && Number(row.student_id) === Number(req.user.id));
    if (!isOwner) {
      return res.status(403).json({ success: false, message: 'You do not have permission to view this certificate.' });
    }

    const revocations = await query(
      `SELECT r.reason, r.revoked_at, r.blockchain_tx_hash, u.name AS revoked_by_name
         FROM revocations r LEFT JOIN users u ON u.id = r.revoked_by
        WHERE r.certificate_id = $1 ORDER BY r.revoked_at DESC`,
      [id]
    );
    const analyses = await query(
      `SELECT id, risk_score, classification, findings, provider, model, analysis_status, unavailable_reason, created_at
         FROM ai_analyses WHERE certificate_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [id]
    );
    const verifications = await query(
      `SELECT id, verification_method, hash_match, final_result, created_at
         FROM verifications WHERE certificate_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [id]
    );
    const qrDataUrl = await qrService.generateQrDataUrl(row.certificate_id).catch(() => null);

    return res.json({
      success: true,
      data: {
        certificate: certSummary(row),
        institution: {
          id: row.institution_id,
          name: row.institution_name,
          verificationStatus: row.institution_status,
        },
        revocations: revocations.rows,
        aiAnalyses: analyses.rows.map((a) => ({
          id: a.id,
          riskScore: a.risk_score,
          classification: a.classification,
          findings: a.findings,
          provider: a.provider,
          model: a.model,
          status: a.analysis_status,
          unavailableReason: a.unavailable_reason,
          createdAt: a.created_at,
        })),
        verifications: verifications.rows,
        qrDataUrl,
        verificationUrl: qrService.verificationUrl(row.certificate_id),
      },
    });
  } catch (err) {
    return next(err);
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/certificates/:id/revoke                                   */
/* ------------------------------------------------------------------ */
async function revokeCertificate(req, res, next) {
  try {
    const id = Number(req.params.id);
    const result = await query('SELECT * FROM certificates WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'Certificate not found.' });

    if (req.user.role !== 'ADMIN' && Number(row.institution_id) !== Number(req.user.institutionId)) {
      return res.status(403).json({
        success: false,
        message: 'You can only revoke certificates issued by your own institution.',
      });
    }

    const outcome = await certService.revokeCertificate({
      certificate: row,
      revokedBy: req.user.id,
      reason: req.body.reason,
    });

    return res.json({
      success: true,
      message: `Certificate ${row.certificate_id} has been revoked. The blockchain record was updated with a real revocation transaction.`,
      data: {
        certificate: certSummary(outcome.certificate),
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/* ------------------------------------------------------------------ */
/* GET /api/certificates/:id/download - original document              */
/* ------------------------------------------------------------------ */
async function downloadCertificate(req, res, next) {
  try {
    const id = Number(req.params.id);
    const result = await query('SELECT * FROM certificates WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'Certificate not found.' });

    const isOwner =
      req.user.role === 'ADMIN' ||
      (req.user.role === 'INSTITUTION' && Number(row.institution_id) === Number(req.user.institutionId)) ||
      (req.user.role === 'STUDENT' && Number(row.student_id) === Number(req.user.id));
    if (!isOwner) {
      return res.status(403).json({ success: false, message: 'You do not have permission to download this document.' });
    }

    const filePath = resolveStoredPath(row.document_path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'The stored document file is no longer available.' });
    }

    res.setHeader('Content-Type', row.document_mime);
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(row.certificate_id)}${path.extname(row.document_filename) || ''}"`);
    return fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    return next(err);
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/certificates/bulk - CSV issuance, per-row real results    */
/* ------------------------------------------------------------------ */
async function bulkIssue(req, res, next) {
  try {
    const csvFile = req.files && req.files.file ? req.files.file[0] : null;
    const attachedDocs = (req.files && req.files.documents) || [];
    if (!csvFile) {
      cleanupFiles(attachedDocs);
      return res.status(400).json({ success: false, message: 'A CSV file is required.' });
    }
    const institutionId = req.user.institutionId;
    if (!institutionId) {
      deleteStoredFile(path.basename(csvFile.path));
      cleanupFiles(attachedDocs);
      return res.status(403).json({ success: false, message: 'Only institution accounts can issue certificates.' });
    }

    // Attached documents are matched to CSV rows by their original file name
    // (case-insensitive basename). Paths inside the upload directory also work.
    const docsByBasename = new Map();
    for (const doc of attachedDocs) {
      docsByBasename.set(path.basename(doc.originalname || '').toLowerCase(), doc.path);
    }

    const csv = fs.readFileSync(csvFile.path, 'utf8');
    deleteStoredFile(path.basename(csvFile.path));

    const parsed = parseCsv(csv);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    if (parsed.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'The CSV contains no data rows.' });
    }
    if (parsed.rows.length > 100) {
      return res.status(400).json({ success: false, message: 'Bulk issuance is limited to 100 rows per batch.' });
    }

    const results = [];
    let succeeded = 0;
    let failed = 0;
    const consumedDocPaths = new Set();

    for (let i = 0; i < parsed.rows.length; i += 1) {
      const raw = parsed.rows[i];
      const rowNumber = i + 2; // header is row 1

      const validationError = validateBulkRow(raw);
      if (validationError) {
        failed += 1;
        results.push({ row: rowNumber, registerNumber: raw.registerNumber || '', status: 'failed', error: validationError });
        continue;
      }

      // Attach the real document referenced by the documentPath column: either
      // a document attached with this upload (matched by file name) or a file
      // that already exists inside the upload directory.
      const docRef = (raw.documentPath || '').trim();
      let absPath = null;
      if (docRef) {
        const attached = docsByBasename.get(path.basename(docRef).toLowerCase());
        if (attached) {
          absPath = attached;
        } else {
          const resolved = path.isAbsolute(docRef) ? path.resolve(docRef) : path.resolve(uploadRoot(), docRef);
          if (resolved.startsWith(uploadRoot()) && fs.existsSync(resolved)) absPath = resolved;
        }
      }
      if (!absPath) {
        failed += 1;
        results.push({
          row: rowNumber,
          registerNumber: raw.registerNumber,
          status: 'failed',
          error: docRef
            ? 'documentPath does not match a document attached with this upload (by file name) and no such file exists in the upload directory.'
            : 'documentPath column is required. Attach the certificate documents with this upload and put each file name in the documentPath column.',
        });
        continue;
      }
      consumedDocPaths.add(absPath);

      try {
        const stat = fs.statSync(absPath);
        const mime = mimeFromExt(absPath);
        const originalName = docRef ? path.basename(docRef) : path.basename(absPath);
        const outcome = await certService.issueCertificate({
          institutionId,
          createdBy: req.user.id,
          fields: {
            studentName: raw.studentName,
            registrationNumber: raw.registerNumber,
            degree: raw.degree,
            department: raw.department || null,
            semester: raw.semester ? Number(raw.semester) : null,
            certificateType: raw.certificateType,
            academicYear: raw.graduationYear || null,
            marks: null,
            issueDate: raw.issueDate,
            expiryDate: null,
            studentUserId: null,
            studentEmail: raw.studentEmail || null,
            studentPassword: raw.studentPassword || null,
          },
          filePath: absPath,
          originalName,
          mimetype: mime,
          size: stat.size,
        });

        const registered = outcome.certificate.blockchain_status === 'registered';
        succeeded += 1;
        results.push({
          row: rowNumber,
          registerNumber: raw.registerNumber,
          status: registered ? 'issued' : 'issued_not_registered',
          certificateId: outcome.certificate.certificate_id,
          documentHash: outcome.documentHash,
          blockchain: registered
            ? { registered: true, txHash: outcome.certificate.blockchain_tx_hash, blockNumber: outcome.certificate.block_number }
            : { registered: false, reason: outcome.certificate.blockchain_status === 'not_configured' ? 'Smart contract address is not configured.' : 'Blockchain registration did not complete.' },
        });
      } catch (err) {
        failed += 1;
        results.push({ row: rowNumber, registerNumber: raw.registerNumber, status: 'failed', error: err.message });
      }
    }

    await certService.auditLog(req.user.id, 'certificate.bulk_issued', 'institution', String(institutionId), {
      total: parsed.rows.length,
      succeeded,
      failed,
    });

    // Attached documents that no row consumed were never stored as certificate
    // files - delete them so no unused upload is left behind.
    for (const doc of attachedDocs) {
      if (!consumedDocPaths.has(doc.path) && fs.existsSync(doc.path)) {
        deleteStoredFile(path.basename(doc.path));
      }
    }

    return res.json({
      success: true,
      message: `Bulk processing complete: ${succeeded} succeeded, ${failed} failed.`,
      data: { total: parsed.rows.length, succeeded, failed, results },
    });
  } catch (err) {
    return next(err);
  }
}

/* ---------------- helpers ---------------- */

/** Delete files uploaded under the "documents" field (used on early exits). */
function cleanupFiles(docs) {
  for (const doc of docs || []) {
    try {
      if (doc && doc.path && fs.existsSync(doc.path)) deleteStoredFile(path.basename(doc.path));
    } catch (_) {
      /* cleanup is best-effort */
    }
  }
}

/** GET /api/certificates/bulk-template - header-only CSV (no fake rows). */
async function bulkTemplate(req, res) {
  const header = 'studentName,registerNumber,studentEmail,studentPassword,degree,department,semester,graduationYear,certificateType,issueDate,documentPath';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bulk-issuance-template.csv"');
  return res.send(header + '\n');
}

function uploadRoot() {
  return require('../utils/fileUtils').uploadDir();
}

function sanitizeFilename(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

function validateBulkRow(raw) {
  if (!raw.studentName || raw.studentName.length < 2) return 'studentName is required (min 2 characters).';
  if (!raw.registerNumber) return 'registerNumber is required.';
  if (!raw.degree || raw.degree.length < 2) return 'degree is required.';
  if (!raw.certificateType || !CERTIFICATE_TYPES.includes(raw.certificateType)) {
    return `certificateType must be one of: ${CERTIFICATE_TYPES.join(', ')}.`;
  }
  if (!raw.issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(raw.issueDate) || isNaN(Date.parse(raw.issueDate))) {
    return 'issueDate must be YYYY-MM-DD.';
  }
  if (raw.graduationYear && !/^(19|20)\d{2}$/.test(raw.graduationYear)) {
    return 'graduationYear must be a 4-digit year.';
  }
  if (raw.semester && (!/^\d{1,2}$/.test(raw.semester) || Number(raw.semester) < 1 || Number(raw.semester) > 10)) {
    return 'semester must be between 1 and 10 (or empty).';
  }
  if (!raw.studentEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.studentEmail)) {
    return 'studentEmail is required and must be a valid email address.';
  }
  if (!raw.studentPassword || raw.studentPassword.length < 8) {
    return 'studentPassword is required and must be at least 8 characters.';
  }
  return null;
}

/** Minimal RFC-4180 CSV parser (quotes, embedded commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return { rows: [], error: 'The CSV file is empty.' };

  const header = nonEmpty[0].map((h) => h.trim());
  const aliases = {
    studentName: ['studentname', 'student_name', 'name'],
    registerNumber: ['registernumber', 'register_number', 'registrationnumber', 'registration_number', 'rollnumber'],
    studentEmail: ['studentemail', 'student_email', 'email'],
    studentPassword: ['studentpassword', 'student_password', 'password'],
    degree: ['degree', 'programme', 'program', 'credential'],
    department: ['department', 'dept'],
    semester: ['semester', 'sem', 'semesternumber'],
    certificateType: ['certificatetype', 'certificate_type', 'type'],
    graduationYear: ['graduationyear', 'graduation_year', 'academicyear', 'academic_year', 'year'],
    issueDate: ['issuedate', 'issue_date', 'date'],
    documentPath: ['documentpath', 'document_path', 'file', 'filepath', 'file_path'],
  };

  const mapping = {};
  header.forEach((h, idx) => {
    const key = h.toLowerCase().replace(/\s+/g, '');
    for (const [canonical, list] of Object.entries(aliases)) {
      if (list.includes(key)) {
        mapping[canonical] = idx;
        break;
      }
    }
  });

  const required = ['studentName', 'registerNumber', 'degree', 'certificateType', 'issueDate', 'documentPath'];
  const missing = required.filter((k) => mapping[k] === undefined);
  if (missing.length > 0) {
    return { rows: [], error: `CSV is missing required columns: ${missing.join(', ')}.` };
  }

  const data = nonEmpty.slice(1).map((r) => {
    const obj = {};
    for (const [canonical, idx] of Object.entries(mapping)) {
      obj[canonical] = (r[idx] || '').trim();
    }
    return obj;
  });

  return { rows: data, error: null };
}

module.exports = {
  createCertificate,
  listCertificates,
  getCertificate,
  revokeCertificate,
  downloadCertificate,
  bulkIssue,
  bulkTemplate,
  certSummary,
  parseCsv,
};
