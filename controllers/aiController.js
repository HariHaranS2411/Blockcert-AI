'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const aiService = require('../services/aiService');
const ocrService = require('../services/ocrService');
const { deleteStoredFile } = require('../utils/fileUtils');
const certService = require('../services/certificateService');

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
      if (req.user.role !== 'ADMIN' && Number(certRow.institution_id) !== Number(req.user.institutionId)) {
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
      const result = await aiService.analyzeDocument({
        ocrText: ocr.text,
        filePath,
        mimetype: req.file.mimetype,
        certificateId,
      });

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
        });
      }

      deleteStoredFile(path.basename(filePath));

      return res.json({
        success: true,
        message: `AI analysis complete: risk score ${result.riskScore}/100 (${result.classification}).`,
        data: {
          analysisStatus: 'completed',
          analysisId: persistedId,
          riskScore: result.riskScore,
          classification: result.classification,
          band: aiService.classifyScore(result.riskScore),
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
      (req.user.role === 'EMPLOYER');
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

module.exports = { analyze, getAnalyses, resumeSummary };
