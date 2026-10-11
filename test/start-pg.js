'use strict';
/**
 * Test-support: starts an embedded PostgreSQL instance for local testing.
 * Not part of the application runtime - used only by scripts in test/.
 */
const fs = require('fs');
const path = require('path');
const mod = require('embedded-postgres');
const EmbeddedPostgres = mod.default || mod;

async function main() {
  const databaseDir = './test/.pgdata';
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'blockcert',
    password: 'blockcert-test',
    port: 5433,
    persistent: false,
  });
  // Only initialise a fresh cluster. If the data directory already holds an
  // initialised cluster (e.g. after a hard kill where stop() never ran),
  // re-running initdb would fail on the non-empty directory.
  const alreadyInitialised = fs.existsSync(databaseDir) && fs.existsSync(path.join(databaseDir, 'PG_VERSION'));
  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();
  if (!alreadyInitialised) {
    await pg.createDatabase('blockcert');
  }
  console.log('READY pg on 5433');
  process.on('SIGTERM', async () => {
    await pg.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('PG_START_FAILED', err.message);
  process.exit(1);
});
