'use strict';

const { Pool } = require('pg');

let pool = null;
let configured = false;

function initDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    configured = false;
    return null;
  }
  configured = true;
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

function isDatabaseConfigured() {
  return configured;
}

function getPool() {
  if (!pool) throw new Error('DATABASE_URL is not configured.');
  return pool;
}

/** Run a parameterized query. Throws a tagged error when the DB is unreachable. */
async function query(text, params) {
  const p = getPool();
  try {
    return await p.query(text, params);
  } catch (err) {
    if (isConnectionError(err)) {
      const e = new Error('Database connection unavailable.');
      e.code = 'DB_UNAVAILABLE';
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

async function withTransaction(fn) {
  const p = getPool();
  const client = await p.connect().catch((err) => {
    if (isConnectionError(err)) {
      const e = new Error('Database connection unavailable.');
      e.code = 'DB_UNAVAILABLE';
      e.cause = err;
      throw e;
    }
    throw err;
  });
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback failure */
    }
    if (isConnectionError(err)) {
      const e = new Error('Database connection unavailable.');
      e.code = 'DB_UNAVAILABLE';
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    client.release();
  }
}

function isConnectionError(err) {
  if (!err) return false;
  if (err.code === 'DB_UNAVAILABLE') return true;
  const code = err.code || (err.cause && err.cause.code);
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === '57P03' || // cannot connect now
    code === '08006' || // connection failure
    code === '08001' ||
    code === '08003' ||
    code === '08004' ||
    /connection|connect/i.test(err.message || '')
  );
}

/** Lightweight health probe used by the dashboard/system health endpoint. */
async function checkDatabaseHealth() {
  if (!configured) {
    return { configured: false, connected: false, message: 'DATABASE_URL is not configured.' };
  }
  try {
    await query('SELECT 1');
    return { configured: true, connected: true, message: 'Connected.' };
  } catch (err) {
    return { configured: true, connected: false, message: err.message || 'Database connection unavailable.' };
  }
}

module.exports = {
  initDatabase,
  getPool,
  query,
  withTransaction,
  isDatabaseConfigured,
  checkDatabaseHealth,
};
