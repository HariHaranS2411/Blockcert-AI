'use strict';

const { query } = require('../config/database');

/** GET /api/employer/history - verification history for this employer account */
async function history(req, res, next) {
  try {
    const result = await query(
      `SELECT v.id, v.certificate_ref, v.verification_method, v.hash_match, v.blockchain_status,
              v.ai_result, v.ai_risk_score, v.final_result, v.created_at,
              c.certificate_id AS cert_id, i.name AS institution_name
         FROM verifications v
         LEFT JOIN certificates c ON c.id = v.certificate_id
         LEFT JOIN institutions i ON i.id = c.institution_id
        WHERE v.verifier_id = $1
        ORDER BY v.created_at DESC
        LIMIT 200`,
      [req.user.id]
    );

    const summary = { VERIFIED: 0, SUSPICIOUS: 0, TAMPERED: 0, REVOKED: 0, NOT_FOUND: 0 };
    for (const row of result.rows) {
      if (summary[row.final_result] !== undefined) summary[row.final_result] += 1;
    }

    return res.json({
      success: true,
      data: {
        history: result.rows.map((r) => ({
          id: r.id,
          certificateRef: r.cert_id || r.certificate_ref,
          institution: r.institution_name,
          method: r.verification_method,
          hashMatch: r.hash_match,
          blockchainStatus: r.blockchain_status,
          aiResult: r.ai_result,
          aiRiskScore: r.ai_risk_score,
          finalResult: r.final_result,
          createdAt: r.created_at,
        })),
        summary,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/employer/bulk-template - CSV template with header only (no data rows) */
async function bulkTemplate(req, res, next) {
  try {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="verification-ids-template.csv"');
    return res.send('certificateId\n');
  } catch (err) {
    return next(err);
  }
}

module.exports = { history, bulkTemplate };
