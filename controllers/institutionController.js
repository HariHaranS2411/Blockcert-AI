'use strict';

const { query } = require('../config/database');
const { auditLog } = require('../services/certificateService');

/** GET /api/institutions/:id */
async function getInstitution(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (req.user.role !== 'ADMIN' && Number(req.user.institutionId) !== id) {
      return res.status(403).json({ success: false, message: 'You can only view your own institution.' });
    }
    const result = await query('SELECT * FROM institutions WHERE id = $1', [id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Institution not found.' });
    return res.json({ success: true, data: { institution: result.rows[0] } });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/institutions - public list (name + status only) */
async function listInstitutions(req, res, next) {
  try {
    const result = await query(
      'SELECT id, name, verification_status, website FROM institutions ORDER BY name ASC LIMIT 500'
    );
    return res.json({ success: true, data: { institutions: result.rows } });
  } catch (err) {
    return next(err);
  }
}

/** PUT /api/institutions/:id - profile update by owner or admin */
async function updateInstitution(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (req.user.role !== 'ADMIN' && Number(req.user.institutionId) !== id) {
      return res.status(403).json({ success: false, message: 'You can only update your own institution.' });
    }
    const { name, registrationNumber, officialEmail, address, website, walletAddress } = req.body;

    const result = await query(
      `UPDATE institutions
          SET name = $2, registration_number = $3, official_email = $4, address = $5,
              website = $6, wallet_address = $7, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, name, registrationNumber || null, officialEmail, address || null, website || null, walletAddress || null]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Institution not found.' });

    await auditLog(req.user.id, 'institution.updated', 'institution', String(id), { fields: Object.keys(req.body) });
    return res.json({ success: true, message: 'Institution profile updated.', data: { institution: result.rows[0] } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'That official email is already in use by another institution.' });
    }
    return next(err);
  }
}

/**
 * POST /api/institutions - create an institution record.
 * An INSTITUTION account that has no linked institution may create one
 * (linked to itself, status PENDING); an ADMIN may create one directly.
 */
async function createInstitution(req, res, next) {
  try {
    const { name, registrationNumber, officialEmail, address, website, walletAddress } = req.body;

    if (req.user.role === 'INSTITUTION' && req.user.institutionId) {
      return res.status(409).json({
        success: false,
        message: 'Your account is already linked to an institution. Update it instead.',
      });
    }
    if (req.user.role !== 'INSTITUTION' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Only institution or admin accounts can create institutions.' });
    }

    const result = await query(
      `INSERT INTO institutions (name, registration_number, official_email, address, website, wallet_address)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, registrationNumber || null, officialEmail, address || null, website || null, walletAddress || null]
    );
    const institution = result.rows[0];

    if (req.user.role === 'INSTITUTION') {
      await query('UPDATE users SET institution_id = $2, updated_at = NOW() WHERE id = $1', [req.user.id, institution.id]);
    }

    await auditLog(req.user.id, 'institution.created', 'institution', String(institution.id), {
      status: institution.verification_status,
    });

    return res.status(201).json({
      success: true,
      message: 'Institution created. It is pending admin approval.',
      data: { institution },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'That official email is already in use by another institution.' });
    }
    return next(err);
  }
}

module.exports = { createInstitution, getInstitution, listInstitutions, updateInstitution };
