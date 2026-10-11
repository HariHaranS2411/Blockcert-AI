'use strict';

/**
 * Applies schema migrations (structure only - never inserts business data).
 * Usage: npm run db:migrate
 */

require('dotenv').config();
const { initDatabase, query, isDatabaseConfigured } = require('../config/database');
const { MIGRATIONS } = require('../models/databaseSchema');

async function main() {
  initDatabase();
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL is not configured. Copy .env.example to .env and set DATABASE_URL.');
    process.exit(1);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const migration of MIGRATIONS) {
    const existing = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration.name]);
    if (existing.rowCount > 0) {
      console.log(`- ${migration.name} already applied`);
      continue;
    }
    await query(migration.sql);
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
    console.log(`+ ${migration.name} applied`);
  }

  console.log('Database schema is up to date. No business data was inserted.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
