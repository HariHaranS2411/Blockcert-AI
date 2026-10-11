'use strict';

const { query, checkDatabaseHealth } = require('../config/database');
const { checkBlockchainHealth } = require('../config/blockchain');
const aiService = require('../services/aiService');

/**
 * GET /api/dashboard - role-scoped real statistics.
 * A fresh install legitimately returns zeros - never hardcoded numbers.
 */
async function stats(req, res, next) {
  try {
    if (req.user.role === 'INSTITUTION') {
      const certStats = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                COUNT(*) FILTER (WHERE status = 'REVOKED')::int AS revoked,
                COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended,
                COUNT(*) FILTER (WHERE blockchain_status = 'registered')::int AS registered,
                COUNT(*) FILTER (WHERE blockchain_status = 'failed')::int AS failedBlockchain,
                COUNT(*) FILTER (WHERE blockchain_status = 'pending')::int AS pendingBlockchain
           FROM certificates WHERE institution_id = $1`,
        [req.user.institutionId]
      );
      const verifStats = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE final_result = 'VERIFIED')::int AS verified,
                COUNT(*) FILTER (WHERE final_result = 'SUSPICIOUS')::int AS suspicious,
                COUNT(*) FILTER (WHERE final_result = 'TAMPERED')::int AS tampered,
                COUNT(*) FILTER (WHERE final_result = 'REVOKED')::int AS revoked,
                COUNT(*) FILTER (WHERE final_result = 'NOT_FOUND')::int AS notFound
           FROM verifications v JOIN certificates c ON c.id = v.certificate_id
          WHERE c.institution_id = $1`,
        [req.user.institutionId]
      );
      const recent = await query(
        `SELECT c.certificate_id, c.degree, c.certificate_type, c.status, c.blockchain_status, c.created_at
           FROM certificates c WHERE c.institution_id = $1
          ORDER BY c.created_at DESC LIMIT 8`,
        [req.user.institutionId]
      );
      const recentVerifications = await query(
        `SELECT v.id, v.certificate_ref, v.verification_method, v.final_result, v.created_at
           FROM verifications v JOIN certificates c ON c.id = v.certificate_id
          WHERE c.institution_id = $1 ORDER BY v.created_at DESC LIMIT 8`,
        [req.user.institutionId]
      );
      const institution = await query('SELECT * FROM institutions WHERE id = $1', [req.user.institutionId]);

      return res.json({
        success: true,
        data: {
          role: 'INSTITUTION',
          certificates: certStats.rows[0],
          verifications: verifStats.rows[0],
          recentCertificates: recent.rows,
          recentVerifications: recentVerifications.rows,
          institution: institution.rows[0] || null,
        },
      });
    }

    if (req.user.role === 'STUDENT') {
      const certStats = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                COUNT(*) FILTER (WHERE status = 'REVOKED')::int AS revoked
           FROM certificates WHERE student_id = $1`,
        [req.user.id]
      );
      const certificates = await query(
        `SELECT c.id, c.certificate_id, c.degree, c.certificate_type, c.academic_year, c.issue_date,
                c.status, c.blockchain_status, i.name AS institution_name
           FROM certificates c JOIN institutions i ON i.id = c.institution_id
          WHERE c.student_id = $1 ORDER BY c.issue_date DESC`,
        [req.user.id]
      );
      const verifStats = await query(
        `SELECT COUNT(*)::int AS total
           FROM verifications v JOIN certificates c ON c.id = v.certificate_id
          WHERE c.student_id = $1`,
        [req.user.id]
      );
      return res.json({
        success: true,
        data: {
          role: 'STUDENT',
          certificates: certStats.rows[0],
          verifications: verifStats.rows[0],
          recentCertificates: certificates.rows,
        },
      });
    }

    if (req.user.role === 'EMPLOYER') {
      const verifStats = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE final_result = 'VERIFIED')::int AS verified,
                COUNT(*) FILTER (WHERE final_result = 'SUSPICIOUS')::int AS suspicious,
                COUNT(*) FILTER (WHERE final_result = 'TAMPERED')::int AS tampered,
                COUNT(*) FILTER (WHERE final_result = 'REVOKED')::int AS revoked,
                COUNT(*) FILTER (WHERE final_result = 'NOT_FOUND')::int AS notFound
           FROM verifications WHERE verifier_id = $1`,
        [req.user.id]
      );
      const recent = await query(
        `SELECT id, certificate_ref, verification_method, final_result, created_at
           FROM verifications WHERE verifier_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [req.user.id]
      );
      return res.json({
        success: true,
        data: { role: 'EMPLOYER', verifications: verifStats.rows[0], recentVerifications: recent.rows },
      });
    }

    // ADMIN: full system counts are served by /api/admin/dashboard
    return res.json({ success: true, data: { role: 'ADMIN', redirectTo: '/api/admin/dashboard' } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/dashboard/public - landing page counts from real queries.
 * If the database is unavailable the client shows no numbers at all.
 */
async function publicCounts(req, res, next) {
  try {
    const certificates = await query('SELECT COUNT(*)::int AS total FROM certificates');
    const institutions = await query("SELECT COUNT(*)::int AS total FROM institutions WHERE verification_status = 'APPROVED'");
    const verifications = await query('SELECT COUNT(*)::int AS total FROM verifications');
    const verified = await query("SELECT COUNT(*)::int AS total FROM verifications WHERE final_result = 'VERIFIED'");

    const dbHealth = await checkDatabaseHealth();
    const chainHealth = await checkBlockchainHealth();

    return res.json({
      success: true,
      data: {
        counts: {
          certificates: certificates.rows[0].total,
          institutions: institutions.rows[0].total,
          verifications: verifications.rows[0].total,
          verified: verified.rows[0].total,
        },
        health: {
          database: dbHealth,
          blockchain: chainHealth,
          ai: { configured: aiService.isConfigured() },
        },
      },
    });
  } catch (err) {
    if (err.code === 'DB_UNAVAILABLE') {
      return res.status(503).json({ success: false, message: 'Database connection unavailable.' });
    }
    return next(err);
  }
}

module.exports = { stats, publicCounts };
