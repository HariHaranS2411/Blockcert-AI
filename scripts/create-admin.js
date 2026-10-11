'use strict';

/**
 * Explicit admin setup - the ONLY way an admin account is created.
 * There is no seeding and no default admin.
 *
 * Usage:
 *   node scripts/create-admin.js <name> <email> <password>
 *   or set ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD in the environment.
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { initDatabase, query, withTransaction } = require('../config/database');

async function main() {
  const [, , argName, argEmail, argPassword] = process.argv;
  const name = argName || process.env.ADMIN_NAME;
  const email = (argEmail || process.env.ADMIN_EMAIL || '').toLowerCase();
  const password = argPassword || process.env.ADMIN_PASSWORD;

  if (!name || !email || !password) {
    console.error('Usage: node scripts/create-admin.js <name> <email> <password>');
    console.error('Name, email and password are required (no defaults, no seeded account).');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  initDatabase();

  const existing = await query('SELECT id, role FROM users WHERE LOWER(email) = $1', [email]);
  if (existing.rowCount > 0) {
    if (existing.rows[0].role === 'ADMIN') {
      console.error(`An admin with email ${email} already exists (id ${existing.rows[0].id}).`);
      process.exit(1);
    }
    const promote = await query("UPDATE users SET role = 'ADMIN', is_active = TRUE, updated_at = NOW() WHERE id = $1 RETURNING id", [
      existing.rows[0].id,
    ]);
    console.log(`Existing user ${email} promoted to ADMIN (id ${promote.rows[0].id}).`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'ADMIN') RETURNING id`,
    [name, email, passwordHash]
  );
  await query(
    `INSERT INTO audit_logs (actor_id, action, entity, entity_ref, details) VALUES ($1,'admin.created','user',$2,$3)`,
    [result.rows[0].id, String(result.rows[0].id), JSON.stringify({ via: 'setup-script' })]
  );

  console.log(`Admin account created: ${email} (id ${result.rows[0].id}).`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
