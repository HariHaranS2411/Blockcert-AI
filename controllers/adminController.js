'use strict';

const { query, checkDatabaseHealth } = require('../config/database');
const { checkBlockchainHealth } = require('../config/blockchain');
const aiService = require('../services/aiService');
const certService = require('../services/certificateService');

/** GET /api/admin/dashboard - real counts from real queries (zeros are valid) */
async function dashboard(req, res, next) {
  try {
    const users = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE role = 'STUDENT')::int AS students,
              COUNT(*) FILTER (WHERE role = 'INSTITUTION')::int AS institutionUsers,
              COUNT(*) FILTER (WHERE role = 'EMPLOYER')::int AS employers,
              COUNT(*) FILTER (WHERE role = 'ADMIN')::int AS admins,
              COUNT(*) FILTER (WHERE NOT is_active)::int AS suspended
         FROM users`
    );
    const institutions = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE verification_status = 'APPROVED')::int AS approved,
              COUNT(*) FILTER (WHERE verification_status = 'PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE verification_status = 'REJECTED')::int AS rejected,
              COUNT(*) FILTER (WHERE verification_status = 'SUSPENDED')::int AS suspended
         FROM institutions`
    );
    const certificates = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
              COUNT(*) FILTER (WHERE status = 'REVOKED')::int AS revoked,
              COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended,
              COUNT(*) FILTER (WHERE blockchain_status = 'registered')::int AS registered,
              COUNT(*) FILTER (WHERE blockchain_status = 'failed')::int AS failedBlockchain,
              COUNT(*) FILTER (WHERE blockchain_status = 'pending')::int AS pendingBlockchain,
              COUNT(*) FILTER (WHERE blockchain_status = 'not_configured')::int AS notConfigured
         FROM certificates`
    );
    const verifications = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE final_result = 'VERIFIED')::int AS verified,
              COUNT(*) FILTER (WHERE final_result = 'SUSPICIOUS')::int AS suspicious,
              COUNT(*) FILTER (WHERE final_result = 'TAMPERED')::int AS tampered,
              COUNT(*) FILTER (WHERE final_result = 'REVOKED')::int AS revoked,
              COUNT(*) FILTER (WHERE final_result = 'NOT_FOUND')::int AS notFound
         FROM verifications`
    );
    const audits = await query('SELECT COUNT(*)::int AS total FROM audit_logs');
    const revocations = await query('SELECT COUNT(*)::int AS total FROM revocations');

    const dbHealth = await checkDatabaseHealth();
    const chainHealth = await checkBlockchainHealth();

    return res.json({
      success: true,
      data: {
        users: users.rows[0],
        institutions: institutions.rows[0],
        certificates: certificates.rows[0],
        verifications: verifications.rows[0],
        auditLogs: audits.rows[0],
        revocations: revocations.rows[0],
        systemHealth: {
          database: dbHealth,
          blockchain: chainHealth,
          ai: {
            configured: aiService.isConfigured(),
            message: aiService.isConfigured() ? 'AI provider configured.' : aiService.unavailableReason(),
          },
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/admin/users */
async function listUsers(req, res, next) {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at, i.name AS institution_name, i.verification_status
         FROM users u LEFT JOIN institutions i ON i.id = u.institution_id
        ORDER BY u.created_at DESC LIMIT 500`
    );
    return res.json({ success: true, data: { users: result.rows } });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/admin/institutions */
async function listInstitutions(req, res, next) {
  try {
    const result = await query(
      `SELECT i.*, (SELECT COUNT(*)::int FROM certificates c WHERE c.institution_id = i.id) AS certificate_count,
              (SELECT COUNT(*)::int FROM users u WHERE u.institution_id = i.id) AS user_count
         FROM institutions i ORDER BY i.created_at DESC`
    );
    return res.json({ success: true, data: { institutions: result.rows } });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/admin/certificates */
async function listCertificates(req, res, next) {
  try {
    const result = await query(
      `SELECT c.id, c.certificate_id, c.student_name, c.degree, c.certificate_type, c.status,
              c.blockchain_status, c.blockchain_tx_hash, c.created_at, i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        ORDER BY c.created_at DESC LIMIT 500`
    );
    return res.json({ success: true, data: { certificates: result.rows } });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/admin/verifications */
async function listVerifications(req, res, next) {
  try {
    const result = await query(
      `SELECT v.id, v.certificate_ref, v.verification_method, v.final_result, v.ai_result, v.created_at,
              i.name AS institution_name, u.name AS verifier_name
         FROM verifications v
         LEFT JOIN certificates c ON c.id = v.certificate_id
         LEFT JOIN institutions i ON i.id = c.institution_id
         LEFT JOIN users u ON u.id = v.verifier_id
        ORDER BY v.created_at DESC LIMIT 500`
    );
    return res.json({ success: true, data: { verifications: result.rows } });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/admin/audit-logs */
async function auditLogs(req, res, next) {
  try {
    const result = await query(
      `SELECT a.id, a.action, a.entity, a.entity_ref, a.details, a.created_at, u.name AS actor_name, u.role AS actor_role
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC LIMIT 500`
    );
    return res.json({ success: true, data: { logs: result.rows } });
  } catch (err) {
    return next(err);
  }
}

/** PATCH /api/admin/institutions/:id/approve|suspend|reject */
async function setInstitutionStatus(req, res, next) {
  try {
    const id = Number(req.params.id);
    const action = req.path.split('/').pop(); // approve | suspend | reject
    const map = { approve: 'APPROVED', suspend: 'SUSPENDED', reject: 'REJECTED' };
    const status = map[action];
    if (!status) return res.status(404).json({ success: false, message: 'Unknown action.' });

    const result = await query('SELECT * FROM institutions WHERE id = $1', [id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Institution not found.' });

    const updated = await query(
      'UPDATE institutions SET verification_status = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id, status]
    );

    await certService.auditLog(req.user.id, `institution.${action}`, 'institution', String(id), {
      from: result.rows[0].verification_status,
      to: status,
    });

    return res.json({
      success: true,
      message: `Institution ${result.rows[0].name} is now ${status}.`,
      data: { institution: updated.rows[0] },
    });
  } catch (err) {
    return next(err);
  }
}

/** PATCH /api/admin/users/:id/suspend|activate */
async function setUserStatus(req, res, next) {
  try {
    const id = Number(req.params.id);
    const action = req.path.split('/').pop();
    if (!['suspend', 'activate'].includes(action)) {
      return res.status(404).json({ success: false, message: 'Unknown action.' });
    }
    if (id === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot change your own account status.' });
    }
    const target = await query('SELECT id, role, is_active FROM users WHERE id = $1', [id]);
    if (!target.rows[0]) return res.status(404).json({ success: false, message: 'User not found.' });

    const updated = await query(
      'UPDATE users SET is_active = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name, email, role, is_active',
      [id, action === 'activate']
    );
    await certService.auditLog(req.user.id, `user.${action}`, 'user', String(id), {});
    return res.json({
      success: true,
      message: `User ${updated.rows[0].name} ${action === 'activate' ? 'activated' : 'suspended'}.`,
      data: { user: updated.rows[0] },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  dashboard,
  listUsers,
  listInstitutions,
  listCertificates,
  listVerifications,
  auditLogs,
  setInstitutionStatus,
  setUserStatus,
};
