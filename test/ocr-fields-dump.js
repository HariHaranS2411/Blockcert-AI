'use strict';
/* Scratch: dump the inferred fields for given certificate IDs (or all readable docs).
 * Usage: node test/ocr-fields-dump.js [CERT-2026-000020 ...]
 */
require('dotenv').config();
const path = require('path');
const ocrService = require('../services/ocrService');

async function main() {
  const { initDatabase, isDatabaseConfigured, query } = require('../config/database');
  initDatabase();
  if (!isDatabaseConfigured()) { console.error('DB not configured'); process.exit(2); }

  const only = process.argv.slice(2);
  const where = only.length ? `WHERE certificate_id IN (${only.map((_, i) => `$${i + 1}`).join(',')})` : '';
  const res = await query(
    `SELECT certificate_id, document_path, document_mime FROM certificates ${where} ORDER BY id`,
    only
  );

  for (const row of res.rows) {
    const file = path.join(__dirname, '..', 'uploads', row.document_path);
    const out = await ocrService.extractFields(file, row.document_mime || 'application/pdf');
    if (out.status !== 'completed') {
      console.log(`${row.certificate_id}: OCR ${out.status}`);
      continue;
    }
    console.log(`${row.certificate_id}: ${JSON.stringify(out.fields)}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
