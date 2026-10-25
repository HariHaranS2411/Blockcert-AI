'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const aiService = require('../services/aiService');
const ocrService = require('../services/ocrService');
const { deleteStoredFile } = require('../utils/fileUtils');
const certService = require('../services/certificateService');
const duplicateService = require('../services/duplicateService');

/**
 * POST /api/ai/analyze - run a real AI analysis on an uploaded document.
 * Requires a certificate record (upload the document for an existing
 * certificate) or works standalone on a document for fraud screening.
 */
async function analyze(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'A certificate document (PDF/PNG/JPG) is required.' });
    }

    const filePath = req.file.path;
    const certificateId = req.body.certificateId ? String(req.body.certificateId).trim().toUpperCase() : null;

    let certRow = null;
    if (certificateId) {
      const found = await query(
        `SELECT c.*, i.name AS institution_name FROM certificates c
           JOIN institutions i ON i.id = c.institution_id WHERE c.certificate_id = $1`,
        [certificateId]
      );
      certRow = found.rows[0] || null;
      if (!certRow) {
        deleteStoredFile(path.basename(filePath));
        return res.status(404).json({ success: false, message: 'Certificate Not Found.' });
      }
      const isAllowed =
        req.user.role === 'ADMIN' ||
        (req.user.role === 'INSTITUTION' && Number(certRow.institution_id) === Number(req.user.institutionId)) ||
        (req.user.role === 'STUDENT' && Number(certRow.student_id) === Number(req.user.id));
      if (!isAllowed) {
        deleteStoredFile(path.basename(filePath));
        return res.status(403).json({ success: false, message: 'You do not have permission to analyze this certificate.' });
      }
    }

    // Real OCR first - no AI call is made when the document yields no text.
    // Honest unavailability first: if no AI provider is configured we never
    // pretend an analysis could run, regardless of the document.
    if (!aiService.isConfigured()) {
      deleteStoredFile(path.basename(filePath));
      if (certRow) {
        await query(
          `INSERT INTO ai_analyses (certificate_id, document_path, analysis_status, unavailable_reason, provider, model)
           VALUES ($1,$2,'unavailable',$3,$4,$5)`,
          [certRow.id, certRow.document_path, 'AI_API_KEY is not configured.', 'openai-compatible', process.env.AI_MODEL || null]
        );
      }
      return res.status(503).json({
        success: false,
        message: 'AI analysis is currently unavailable.',
        data: { analysisStatus: 'unavailable', reason: 'AI_API_KEY is not configured.' },
      });
    }

    const ocr = await ocrService.extractFields(filePath, req.file.mimetype);
    if (ocr.status !== 'completed') {
      deleteStoredFile(path.basename(filePath));
      return res.status(422).json({
        success: false,
        message: 'Unable to extract sufficient text from this document.',
        data: { analysisStatus: 'unavailable', reason: ocr.error || 'Insufficient text.' },
      });
    }

    try {
      // Deterministic platform check FIRST: does the upload reproduce a
      // certificate already registered here? A copy of an issued document
      // reads identical to the original, so the text-only model cannot see
      // the duplication - but the platform can (hash / content match).
      let duplicate = null;
      try {
        duplicate = await duplicateService.detectDuplicate({
          filePath,
          mimetype: req.file.mimetype,
          text: ocr.text,
          fields: ocr.fields,
          certificateId,
        });
      } catch (dupErr) {
        duplicate = null; // never fabricate a duplicate verdict
      }
      // NOTE: official-record differences are NOT passed to the model as
      // tampering evidence (measured 2026-10-22, test/duplicate-evidence-test):
      // the model scores ANY record mismatch 95/Tampered, but on this platform
      // record-vs-print mismatches are issuance-era typing artifacts, not
      // fraud. They stay in the deterministic 'Duplicate status' check.

      const result = await aiService.analyzeDocument({
        ocrText: ocr.text,
        filePath,
        mimetype: req.file.mimetype,
        certificateId,
      });
      const duplicateCheck = duplicateService.buildDuplicateCheck(duplicate, certificateId);
      if (duplicateCheck) result.checks.unshift(duplicateCheck);

      // Deterministic headline verdict for a recognized duplicate of a
      // registered certificate: a copy that matches the official record is
      // labeled a verified duplicate (authentic-level score kept) while a
      // copy whose printed fields disagree with the record is raised into
      // the Suspicious band by the platform itself - the model never sees
      // the official record, so this cannot come from it.
      const duplicateVerdict = duplicateService.applyDuplicateVerdict(result, duplicate, certificateId);

      let persistedId = null;
      if (certRow) {
        const inserted = await query(
          `INSERT INTO ai_analyses (certificate_id, document_path, risk_score, classification, findings, provider, model, analysis_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'completed') RETURNING id`,
          [
            certRow.id,
            certRow.document_path,
            result.riskScore,
            result.classification,
            JSON.stringify({ checks: result.checks, findings: result.findings }),
            result.provider,
            result.model,
          ]
        );
        persistedId = inserted.rows[0].id;
        await certService.auditLog(req.user.id, 'ai.analyzed', 'certificate', certRow.certificate_id, {
          riskScore: result.riskScore,
          classification: result.classification,
          duplicateVerdict: duplicateVerdict ? duplicateVerdict.verdict : null,
        });
      }

      deleteStoredFile(path.basename(filePath));

      const duplicateMessage = duplicateMessageFor(duplicate, duplicateVerdict, certificateId, result.classification);
      return res.json({
        success: true,
        message: `AI analysis complete: risk score ${result.riskScore}/100 (${result.classification}) — authenticity ${100 - result.riskScore}/100.${duplicateMessage ? ' ' + duplicateMessage : ''}`,
        data: {
          analysisStatus: 'completed',
          analysisId: persistedId,
          riskScore: result.riskScore,
          classification: result.classification,
          band: aiService.classifyScore(result.riskScore),
          authenticityPercent: 100 - result.riskScore,
          duplicateVerdict,
          duplicate: duplicate && duplicate.reference
            ? {
                level: duplicate.level,
                certificateId: duplicate.reference.certificateId,
                differencesCount: duplicate.differences.length,
                differences: duplicate.differences.slice(0, 6),
                verdict: duplicateVerdict ? duplicateVerdict.verdict : null,
              }
            : null,
          checks: result.checks,
          findings: result.findings,
          provider: result.provider,
          model: result.model,
          thresholds: { suspicious: aiService.LOW_THRESHOLD(), tampered: aiService.HIGH_THRESHOLD() },
          disclaimer:
            'AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.',
        },
      });
    } catch (err) {
      deleteStoredFile(path.basename(filePath));
      if (err.code === 'AI_UNAVAILABLE') {
        if (certRow) {
          await query(
            `INSERT INTO ai_analyses (certificate_id, document_path, analysis_status, unavailable_reason, provider, model)
             VALUES ($1,$2,'unavailable',$3,$4,$5)`,
            [certRow.id, certRow.document_path, err.detail || 'Provider request failed.', 'openai-compatible', process.env.AI_MODEL || null]
          ).catch(() => {});
        }
        return res.status(503).json({
          success: false,
          message: 'AI analysis is currently unavailable.',
          data: { analysisStatus: 'unavailable', reason: err.detail || 'Provider request failed.' },
        });
      }
      return next(err);
    }
  } catch (err) {
    if (req.file) deleteStoredFile(path.basename(req.file.path));
    return next(err);
  }
}

/** GET /api/ai/:certificateId - stored analyses for a certificate (authorized) */
async function getAnalyses(req, res, next) {
  try {
    const certificateId = String(req.params.certificateId).trim().toUpperCase();
    const found = await query(
      `SELECT c.id, c.institution_id, c.document_hash, i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.certificate_id = $1`,
      [certificateId]
    );
    const certRow = found.rows[0];
    if (!certRow) return res.status(404).json({ success: false, message: 'Certificate Not Found.' });

    const isPrivileged =
      req.user.role === 'ADMIN' ||
      (req.user.role === 'INSTITUTION' && Number(req.user.institutionId) === Number(certRow.institution_id)) ||
      (req.user.role === 'EMPLOYER') ||
      (req.user.role === 'STUDENT' && Number(certRow.student_id) === Number(req.user.id));
    if (!isPrivileged) {
      return res.status(403).json({ success: false, message: 'You do not have permission to view AI analyses for this certificate.' });
    }

    const result = await query(
      `SELECT id, risk_score, classification, findings, provider, model, analysis_status, unavailable_reason, created_at
         FROM ai_analyses WHERE certificate_id = $1 ORDER BY created_at DESC`,
      [certRow.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          analyses: [],
          emptyState: aiService.isConfigured() ? 'AI analysis has not been performed.' : 'AI analysis is currently unavailable.',
        },
      });
    }

    return res.json({
      success: true,
      data: {
        analyses: result.rows.map((a) => ({
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
        thresholds: { suspicious: aiService.LOW_THRESHOLD(), tampered: aiService.HIGH_THRESHOLD() },
        disclaimer:
          'AI provides a document-risk assessment. Blockchain verification confirms whether the document matches the official issuer record. AI results are not absolute proof of authenticity.',
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/ai/resume-summary
 *
 * Polishes the professional summary of the caller's resume. The FACTS are
 * always re-read from this student's real certificate rows on the server -
 * never taken from the request body - so the model can only rephrase
 * platform-verified data. Returns the polished summary plus the deterministic
 * fallback when AI is unavailable (503 with AI_UNAVAILABLE envelope).
 */
async function resumeSummary(req, res, next) {
  try {
    const userResult = await query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [req.user.id, 'STUDENT']);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    const certResult = await query(
      `SELECT c.degree, c.department, c.semester, c.academic_year, c.marks,
              c.issue_date, c.status, c.blockchain_status, i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.student_id = $1 AND c.status = 'ACTIVE'
        ORDER BY c.issue_date DESC`,
      [req.user.id]
    );
    const certs = certResult.rows;

    if (!certs.length) {
      return res.status(422).json({ success: false, message: 'No active certificates to summarize yet. A resume summary needs at least one verified certificate.' });
    }

    // Facts only - the same data shown on the resume.
    const facts = {
      holderName: user.name,
      certificates: certs.map((c) => ({
        credential: c.degree,
        department: c.department || undefined,
        semester: c.semester || undefined,
        institution: c.institution_name,
        academicYear: c.academic_year || undefined,
        marks: c.marks ? String(c.marks).trim() : undefined,
        issueDate: c.issue_date,
        blockchainVerified: c.blockchain_status === 'registered',
      })),
    };

    // Deterministic fallback built from the SAME facts.
    const degrees = [...new Set(certs.map((c) => c.degree).filter(Boolean))];
    const institutions = [...new Set(certs.map((c) => c.institution_name).filter(Boolean))];
    const verified = certs.filter((c) => c.blockchain_status === 'registered').length;
    let fallback = '';
    const parts = [];
    if (degrees.length) parts.push(`Student with verified academic credentials in ${degrees.join(' and ')} issued by ${institutions.join(' and ')}`);
    if (verified > 0) parts.push(`${verified} of ${certs.length} certificate${certs.length === 1 ? '' : 's'} registered on-chain and independently verifiable`);
    if (parts.length) fallback = parts.join('; ') + '.';

    try {
      const result = await aiService.generateResumeSummary({ facts });
      return res.json({
        success: true,
        message: 'AI summary generated from your verified certificate records.',
        data: {
          summary: result.summary || fallback,
          aiPolished: true,
          provider: result.provider,
          model: result.model,
          fallbackSummary: fallback,
        },
      });
    } catch (err) {
      if (err.code === 'AI_UNAVAILABLE') {
        return res.status(503).json({
          success: false,
          message: err.message || 'AI summary is currently unavailable.',
          data: { analysisStatus: 'unavailable', reason: err.detail || 'AI provider request failed.', fallbackSummary: fallback },
        });
      }
      return next(err);
    }
  } catch (err) {
    return next(err);
  }
}

/** One-line duplicate verdict appended to the analysis message. */
function duplicateMessageFor(duplicate, verdict, requestedCertificateId, classification) {
  if (!duplicate || !duplicate.reference) return '';
  const ref = duplicate.reference.certificateId;
  const reqId = requestedCertificateId ? String(requestedCertificateId).trim().toUpperCase() : null;
  const notThatCert = reqId && reqId !== ref ? ` The document belongs to certificate ${ref}, not the requested ${reqId}.` : '';

  if (duplicate.level === 'byte-exact') {
    return `Verified duplicate: byte-identical to the official document registered for certificate ${ref} — identical content, not altered.${notThatCert}`;
  }
  if (!duplicate.differences.length) {
    return `Verified duplicate: this upload is a copy/re-scan of the official document registered for certificate ${ref} (different bytes, identical content).${notThatCert}`;
  }
  if (duplicate.differences.length) {
    const wrongDoc = reqId && reqId !== ref ? `This upload reproduces certificate ${ref}, not the requested ${reqId},` : `This upload is a copy of certificate ${ref},`;
    let raisedNote = '';
    if (verdict && verdict.elevatedRisk) {
      raisedNote =
        classification === 'Suspicious'
          ? ' The assessment was raised to Suspicious because it differs from the official record.'
          : ` The record mismatch adds to an independent ${classification} assessment of the document itself.`;
    }
    return `Suspicious copy: ${wrongDoc} and ${duplicate.differences.length} field(s) differ from the official record.${raisedNote}`;
  }
  return '';
}

module.exports = { analyze, getAnalyses, resumeSummary };
