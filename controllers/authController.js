'use strict';

const bcrypt = require('bcrypt');
const { query, withTransaction } = require('../config/database');
const { signToken } = require('../middleware/authMiddleware');
const { auditLog } = require('../services/certificateService');

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    institutionId: row.institution_id || null,
    createdAt: row.created_at,
  };
}

/** POST /api/auth/register - real registration, no seeded accounts. */
async function register(req, res, next) {
  try {
    const { name, email, password, role, institutionName, registrationNumber, website, address } = req.body;

    const existing = await query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await withTransaction(async (client) => {
      let institutionId = null;

      if (role === 'INSTITUTION') {
        if (!institutionName) {
          const e = new Error('Institution name is required to register an institution account.');
          e.status = 400;
          throw e;
        }
        const inst = await client.query(
          `INSERT INTO institutions (name, registration_number, official_email, website, address)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [institutionName, registrationNumber || null, email, website || null, address || null]
        );
        institutionId = inst.rows[0].id;
      }

      // Students may provide their institution-issued registration number so
      // issued certificates can be linked to their account (uniquely).
      let studentRegNumber = null;
      if (role === 'STUDENT' && registrationNumber) {
        const clash = await client.query('SELECT 1 FROM users WHERE registration_number = $1', [registrationNumber]);
        if (clash.rowCount > 0) {
          const e = new Error('That registration number is already linked to another account.');
          e.status = 409;
          throw e;
        }
        studentRegNumber = registrationNumber;
      }

      const result = await client.query(
        `INSERT INTO users (name, email, password_hash, role, institution_id, registration_number)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name, email, passwordHash, role, institutionId, studentRegNumber]
      );

      // Link certificates issued earlier with this registration number that
      // could not be linked at issuance (no student account existed yet).
      // Same real linkage rule as issue time: exact registration_number match.
      let linkedCertificates = 0;
      if (role === 'STUDENT' && studentRegNumber) {
        const linked = await client.query(
          `UPDATE certificates
              SET student_id = $1
            WHERE student_id IS NULL AND LOWER(registration_number) = LOWER($2)`,
          [result.rows[0].id, studentRegNumber]
        );
        linkedCertificates = linked.rowCount || 0;
      }

      return { user: result.rows[0], institutionId, linkedCertificates };
    });

    await auditLog(user.user.id, 'auth.register', 'user', String(user.user.id), { role });
    if (user.institutionId) {
      await auditLog(user.user.id, 'institution.created', 'institution', String(user.institutionId), {
        status: 'PENDING',
        note: 'Awaiting admin approval.',
      });
    }

    let institution = null;
    if (user.institutionId) {
      const inst = await query('SELECT id, name, verification_status FROM institutions WHERE id = $1', [user.institutionId]);
      institution = inst.rows[0] || null;
    }

    const token = signToken(user.user);
    return res.status(201).json({
      success: true,
      message:
        role === 'INSTITUTION'
          ? 'Institution account created. Your institution is pending admin approval before certificates can be verified as issuer-approved.'
          : 'Account created successfully.',
      data: { token, user: { ...publicUser(user.user), institution, linkedCertificates: user.linkedCertificates || 0 } },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }
    return next(err);
  }
}

/** POST /api/auth/login */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
    const user = result.rows[0];

    // Same message for unknown email and wrong password (no account enumeration).
    const invalid = { success: false, message: 'Invalid email or password.' };
    if (!user) return res.status(401).json(invalid);

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json(invalid);

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'This account has been suspended. Contact the administrator.' });
    }

    await auditLog(user.id, 'auth.login', 'user', String(user.id), {});

    let institution = null;
    if (user.institution_id) {
      const inst = await query('SELECT id, name, verification_status FROM institutions WHERE id = $1', [user.institution_id]);
      institution = inst.rows[0] || null;
    }

    return res.json({
      success: true,
      message: 'Logged in.',
      data: { token: signToken(user), user: { ...publicUser(user), institution } },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/auth/forgot-password
 * Honest behaviour: no email transport is configured in this stack, so the
 * endpoint never claims that an email was sent. It reports the real state and
 * does not reveal whether the account exists (no account enumeration).
 */
async function forgotPassword(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  }
  // The same response is returned whether or not the account exists, so this
  // endpoint cannot be used to enumerate accounts.
  return res.status(503).json({
    success: false,
    message: 'Password reset by email is not configured on this server. Contact your administrator to reset your password.',
    data: { emailDeliveryConfigured: false },
  });
}

/** GET /api/auth/me */
async function me(req, res, next) {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, message: 'Account not found.' });

    let institution = null;
    if (user.institution_id) {
      const inst = await query(
        'SELECT id, name, verification_status, official_email, website, address, registration_number, wallet_address FROM institutions WHERE id = $1',
        [user.institution_id]
      );
      institution = inst.rows[0] || null;
    }
    return res.json({ success: true, data: { user: { ...publicUser(user), institution } } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { register, login, forgotPassword, me, publicUser };
