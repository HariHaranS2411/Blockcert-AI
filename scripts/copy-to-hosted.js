'use strict';

/**
 * scripts/copy-to-hosted.js
 *
 * Copies every row of the LOCAL database into a hosted (cloud Postgres)
 * database, so the deployed app starts with exactly the data you have now:
 * users (bcrypt hashes, so existing passwords keep working), institutions,
 * certificates with their document fingerprints, revocations, verifications,
 * AI analyses and audit logs.
 *
 * The target must ALREADY have the schema: boot the hosted app once (its
 * migrations create the tables), then run this script.
 *
 * Usage (the target URL is never printed or committed):
 *   node scripts/copy-to-hosted.js --target-file .hosted-db-url          # dry run, reports only
 *   node scripts/copy-to-hosted.js --target-file .hosted-db-url --apply  # performs the copy
 * or, without writing it to a file:
 *   HOSTED_DATABASE_URL=postgres://... node scripts/copy-to-hosted.js --apply
 *
 * The copy is repeatable: the target's application tables are truncated and
 * reloaded from the local database, primary keys are preserved (foreign keys
 * stay valid) and sequences are reset afterwards. `schema_migrations` is left
 * to the hosted app.
 */

require('dotenv').config();

const fs = require('fs');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const TARGET_FILE = (() => {
  const i = process.argv.indexOf('--target-file');
  return i !== -1 ? process.argv[i + 1] : null;
})();

/** Tables the hosted app owns on its own. */
const SKIP_TABLES = new Set(['schema_migrations']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function targetUrl() {
  const env = (process.env.HOSTED_DATABASE_URL || '').trim();
  if (env) return env;
  if (TARGET_FILE) {
    if (!fs.existsSync(TARGET_FILE)) fail(`Target file not found: ${TARGET_FILE}`);
    const value = fs.readFileSync(TARGET_FILE, 'utf8').trim().split(/\s+/)[0];
    if (!value) fail(`Target file ${TARGET_FILE} is empty.`);
    return value;
  }
  fail('No target database. Set HOSTED_DATABASE_URL or pass --target-file <file holding it>.');
}

/**
 * Managed cloud Postgres (Neon and friends) refuses non-TLS connections, while
 * a plain local server refuses TLS: try the URL exactly as given first and only
 * retry with sslmode=require when the URL does not specify an sslmode itself.
 */
async function connectTarget(url) {
  const candidates = [url];
  if (!/sslmode=/.test(url)) candidates.push(url + (url.includes('?') ? '&' : '?') + 'sslmode=require');
  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const client = new Client({ connectionString: candidates[i] });
    try {
      await client.connect();
      if (i > 0) console.log('target: connected with sslmode=require');
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      if (i === 0 && candidates.length > 1) console.log(`target: plain connection failed (${err.message}) - retrying with TLS`);
    }
  }
  throw new Error('Could not connect to the target database: ' + lastError.message);
}

async function tableNames(client) {
  const res = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  return res.rows.map((r) => r.table_name);
}

async function columnsOf(client, table) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

/** Parent tables before the tables that reference them. */
async function insertOrder(client, tables) {
  const res = await client.query(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
  );
  const parents = new Map(tables.map((t) => [t, new Set()]));
  for (const row of res.rows) {
    if (row.child !== row.parent && parents.has(row.child) && parents.has(row.parent)) {
      parents.get(row.child).add(row.parent);
    }
  }
  const order = [];
  const placed = new Set();
  while (order.length < tables.length) {
    let progressed = false;
    for (const table of tables) {
      if (placed.has(table)) continue;
      if ([...parents.get(table)].every((p) => placed.has(p))) {
        order.push(table);
        placed.add(table);
        progressed = true;
      }
    }
    if (!progressed) {
      // Dependency cycle (or a self-reference we already guard against): keep
      // the remaining tables in name order rather than looping forever.
      for (const table of tables) {
        if (!placed.has(table)) {
          order.push(table);
          placed.add(table);
        }
      }
    }
  }
  return order;
}

async function sequenceColumns(client, table) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

async function main() {
  const source = new Client({ connectionString: process.env.DATABASE_URL });

  await source.connect();
  console.log('source: connected (local database)');
  const target = await connectTarget(targetUrl());
  console.log('target: connected');

  const sourceTables = (await tableNames(source)).filter((t) => !SKIP_TABLES.has(t));
  const targetTables = new Set(await tableNames(target));

  const missing = sourceTables.filter((t) => !targetTables.has(t));
  if (missing.length) {
    await source.end();
    await target.end();
    fail(
      `The target is missing ${missing.length} table(s): ${missing.join(', ')}\n` +
        'Boot the hosted app once (its migrations create the schema), then run this again.'
    );
  }

  const order = await insertOrder(source, sourceTables);

  let sourceTotal = 0;
  for (const table of sourceTables) {
    const res = await source.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
    sourceTotal += res.rows[0].n;
  }
  console.log(`tables to copy: ${sourceTables.length} (${sourceTotal} rows) — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  if (!APPLY) {
    for (const table of order) {
      const res = await source.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
      console.log(`  would copy ${String(res.rows[0].n).padStart(6)}  ${table}`);
    }
    console.log('\nDry run only — re-run with --apply to write into the hosted database.');
    await source.end();
    await target.end();
    return;
  }

  await target.query('BEGIN');
  await target.query(`TRUNCATE TABLE ${sourceTables.map((t) => `"${t}"`).join(', ')} CASCADE`);
  await target.query('COMMIT');
  console.log('target: application tables cleared');

  const BATCH = 100;
  for (const table of order) {
    const targetCols = await columnsOf(target, table);
    const sourceCols = await columnsOf(source, table);
    const cols = targetCols.filter((c) => sourceCols.includes(c));
    if (!cols.length) fail(`No shared columns for table ${table}.`);
    const res = await source.query(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`);
    const rows = res.rows;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = [];
      const tuples = chunk.map((row) => {
        const placeholders = cols.map((c) => {
          values.push(row[c]);
          return `$${values.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await target.query(
        `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${tuples.join(', ')}`,
        values
      );
    }
    if (rows.length) console.log(`  copied ${String(rows.length).padStart(6)}  ${table}`);

    for (const col of await sequenceColumns(source, table)) {
      const seq = await target.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [table, col]);
      if (!seq.rows[0].seq) continue;
      const max = await target.query(`SELECT MAX("${col}")::bigint AS max FROM "${table}"`);
      const value = max.rows[0].max;
      if (value === null) await target.query('SELECT setval($1, 1, false)', [seq.rows[0].seq]);
      else await target.query('SELECT setval($1, $2, true)', [seq.rows[0].seq, value]);
    }
  }

  console.log('\nverification (target row counts):');
  let ok = true;
  for (const table of sourceTables) {
    const s = (await source.query(`SELECT COUNT(*)::int AS n FROM "${table}"`)).rows[0].n;
    const t = (await target.query(`SELECT COUNT(*)::int AS n FROM "${table}"`)).rows[0].n;
    const match = s === t;
    if (!match) ok = false;
    console.log(`  ${match ? 'ok  ' : 'FAIL'} ${String(t).padStart(6)}/${String(s).padEnd(6)} ${table}`);
  }

  await source.end();
  await target.end();
  if (!ok) fail('\nRow counts do not match — the hosted data was NOT verified as a full copy.');
  console.log('\nDone: the hosted database now holds the same data as the local one.');
}

main().catch((err) => {
  console.error('Copy failed:', err.message);
  process.exit(1);
});
