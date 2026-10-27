'use strict';

/**
 * Cloud boot (used in the Docker container, `npm run start:cloud`).
 *
 * A hosted container has no persistent local chain, so EVERY boot:
 *   1. starts a fresh ephemeral Ganache chain in-process,
 *   2. captures account #0's real private key for the issuer wallet,
 *   3. compiles + deploys CertificateRegistry to the fresh chain,
 *   4. applies DB migrations (idempotent, structure only),
 *   5. bootstraps the ADMIN from ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD
 *      when the database has no admin yet (idempotent demo setup),
 *   6. hands over to the normal server startup.
 *
 * Nothing is fabricated: the contract address is the REAL deployed address
 * of THIS boot's chain, and the database (external, e.g. cloud Postgres)
 * is the source of truth. Certificates issued through the API are
 * registered on-chain in real time by certificateService as usual.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const ganache = require('ganache');
const bcrypt = require('bcrypt');
const { ethers } = require('ethers');

const CHAIN_PORT = (() => {
  const n = Number(process.env.GANACHE_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 7545;
})();

function compileRegistry() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'CertificateRegistry.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'CertificateRegistry.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    const e = new Error('Solidity compilation failed: ' + errors.map((x) => x.formattedMessage).join(' | '));
    e.fatal = true;
    throw e;
  }
  const contract = output.contracts['CertificateRegistry.sol']['CertificateRegistry'];
  return { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
}

async function startGanache() {
  const server = ganache.server({
    chain: { chainId: 1337, networkId: 1337 },
    wallet: { totalAccounts: 10 },
    logging: { quiet: true },
  });
  await server.listen(CHAIN_PORT);
  const accounts = server.provider.getInitialAccounts();
  const [issuer] = Object.values(accounts);
  // The app's issuer wallet is the funded account #0 (has pre-funded ETH).
  process.env.BLOCKCHAIN_RPC_URL = `http://127.0.0.1:${CHAIN_PORT}`;
  process.env.BLOCKCHAIN_PRIVATE_KEY = issuer.secretKey;
  console.log(`[cloud-boot] ephemeral chain up on :${CHAIN_PORT} (chainId 1337)`);
  return server;
}

async function deployContract() {
  const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
  const wallet = new ethers.Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY, provider);
  const { abi, bytecode } = compileRegistry();
  const receipt = await (await new ethers.ContractFactory(abi, bytecode, wallet).deploy()).deploymentTransaction().wait();
  if (receipt.status !== 1) throw new Error('Contract deployment transaction failed.');
  process.env.CONTRACT_ADDRESS = receipt.contractAddress;
  console.log(`[cloud-boot] CertificateRegistry deployed at ${receipt.contractAddress} (block ${receipt.blockNumber})`);
  return receipt.contractAddress;
}

async function applyMigrations() {
  const { initDatabase, query, isDatabaseConfigured } = require('../config/database');
  const { MIGRATIONS } = require('../models/databaseSchema');
  initDatabase();
  if (!isDatabaseConfigured()) {
    console.warn('[cloud-boot] DATABASE_URL is not configured - the app will report an honest "database unavailable" state.');
    return;
  }
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const migration of MIGRATIONS) {
    const existing = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration.name]);
    if (existing.rowCount > 0) continue;
    await query(migration.sql);
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
    console.log(`[cloud-boot] migration applied: ${migration.name}`);
  }
}

/** Create the admin from env ONLY when the database has no admin yet. */
async function bootstrapAdmin() {
  const name = process.env.ADMIN_NAME;
  const email = process.env.ADMIN_EMAIL ? String(process.env.ADMIN_EMAIL).toLowerCase() : null;
  const password = process.env.ADMIN_PASSWORD;
  if (!name || !email || !password) return; // not requested - skip silently

  const { query } = require('../config/database');
  const admins = await query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1");
  if (admins.rowCount > 0) return; // an admin already exists - never touch it

  if (password.length < 8) {
    console.error('[cloud-boot] ADMIN_PASSWORD must be at least 8 characters - no admin created.');
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const inserted = await query("INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'ADMIN') RETURNING id", [name, email, passwordHash]);
  await query("INSERT INTO audit_logs (actor_id, action, entity, entity_ref, details) VALUES ($1,'admin.created','user',$2,$3)", [inserted.rows[0].id, String(inserted.rows[0].id), JSON.stringify({ via: 'cloud-boot' })]);
  console.log(`[cloud-boot] admin bootstrap: ${email} (id ${inserted.rows[0].id})`);
}

/**
 * Re-align persisted chain state with THIS boot's fresh chain (the container
 * has no persistent chain, same situation scripts/resync-chain.js documents
 * for the local Ganache):
 *   1. institution wallet addresses -> this boot's issuer key, so issuer
 *      checks keep matching;
 *   2. re-register every certificate whose on-chain record is missing and
 *      re-apply revocations — scripts/resync-chain.js --apply, the same
 *      recovery issuance uses; conflicting fingerprints are reported and
 *      never silently adopted.
 */
async function bootstrapChainState() {
  const { initBlockchain, isBlockchainConfigured, getUnavailableReason } = require('../config/blockchain');
  initBlockchain();
  if (!isBlockchainConfigured()) {
    throw new Error('Blockchain failed to initialise after deployment: ' + getUnavailableReason());
  }

  const { initDatabase, query, isDatabaseConfigured } = require('../config/database');
  initDatabase();
  if (!isDatabaseConfigured()) return;

  const issuerAddress = new ethers.Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY).address.toLowerCase();
  const realigned = await query(
    `UPDATE institutions
        SET wallet_address = $1, updated_at = NOW()
      WHERE wallet_address IS NOT NULL AND LOWER(wallet_address) <> $1
      RETURNING id`,
    [issuerAddress]
  );
  console.log(`[cloud-boot] institution wallet realignment: ${realigned.rowCount} row(s) updated`);
  if (realigned.rowCount > 0) {
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity, details) VALUES (NULL,'blockchain.wallet_realigned','institution',$1)`,
      [JSON.stringify({ updated: realigned.rowCount, issuer: issuerAddress })]
    ).catch(() => {});
  }

  // Re-register every certificate whose on-chain record is missing and
  // re-apply revocations — same recovery scripts/resync-chain.js --apply
  // performs (in-process here: a separate child process hangs at its first
  // RPC call while this boot's provider is the only reliable one).
  const blockchainService = require('../services/blockchainService');
  const certService = require('../services/certificateService');
  const certs = await query(
    `SELECT id, certificate_id, status, document_hash, blockchain_status, blockchain_tx_hash, block_number
       FROM certificates ORDER BY id`
  );
  let issued = 0, revokedAgain = 0, conflicts = 0, errors = 0;
  for (const cert of certs.rows) {
    let record = null;
    try {
      record = await blockchainService.getCertificateRecord(cert.certificate_id);
    } catch (err) {
      console.error('[cloud-boot] chain read failed for ' + cert.certificate_id + ': ' + err.message);
      errors += 1;
      continue;
    }
    if (record) {
      const chainHash = String(record.certificateHash || '').toLowerCase();
      const dbHash = String(cert.document_hash || '').toLowerCase();
      if (dbHash && chainHash && chainHash !== dbHash) {
        console.error('[cloud-boot] fingerprint conflict for ' + cert.certificate_id + ' - left untouched');
        conflicts += 1;
        continue;
      }
      if (cert.status === 'REVOKED' && !record.revoked) {
        try {
          const r = await blockchainService.revokeCertificate(cert.certificate_id);
          await query('UPDATE revocations SET blockchain_tx_hash = $2 WHERE certificate_id = $1', [cert.id, r.txHash]);
          revokedAgain += 1;
        } catch (err) {
          console.error('[cloud-boot] revoke failed for ' + cert.certificate_id + ': ' + err.message);
          errors += 1;
        }
      }
      continue;
    }
    if (!cert.document_hash) continue;
    try {
      const res = await certService.registerOnBlockchain(cert);
      if (res.ok) {
        issued += 1;
        if (cert.status === 'REVOKED') {
          const r = await blockchainService.revokeCertificate(cert.certificate_id);
          await query('UPDATE revocations SET blockchain_tx_hash = $2 WHERE certificate_id = $1', [cert.id, r.txHash]);
          revokedAgain += 1;
        }
      } else {
        console.error('[cloud-boot] register failed for ' + cert.certificate_id + ': ' + (res.reason || 'unknown'));
        errors += 1;
      }
    } catch (err) {
      console.error('[cloud-boot] register failed for ' + cert.certificate_id + ': ' + err.message);
      errors += 1;
    }
  }
  console.log(`[cloud-boot] chain resync: re-registered ${issued}, re-revoked ${revokedAgain}, conflicts ${conflicts}, errors ${errors}`);
}

async function main() {
  await startGanache();
  await deployContract();
  await applyMigrations();
  await bootstrapAdmin().catch((err) => console.error('[cloud-boot] admin bootstrap failed:', err.message));
  await bootstrapChainState().catch((err) => console.error('[cloud-boot] chain state bootstrap failed:', err.message));

  const { start } = require('../server');
  await start();
}

main().catch((err) => {
  console.error('Cloud boot failed:', err.fatal ? err.message : err.shortMessage || err.message);
  process.exit(1);
});
