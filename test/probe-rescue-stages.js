'use strict';
/* Scratch probe: replicate the extractFields rescue sequence stage by stage
 * for one stored image document, printing each pass's text and field
 * inference so merge decisions can be diagnosed. Usage:
 * node test/probe-rescue-stages.js CERT-2026-000025
 */
require('dotenv').config();
const path = require('path');
const ocrService = require('../services/ocrService');

async function main() {
  const certId = process.argv[2];
  if (!certId) { console.error('usage: node test/probe-rescue-stages.js CERT-...'); process.exit(2); }
  const { initDatabase, isDatabaseConfigured, query } = require('../config/database');
  initDatabase();
  if (!isDatabaseConfigured()) { console.error('DB not configured'); process.exit(2); }

  const res = await query(
    'SELECT certificate_id, document_path, document_mime FROM certificates WHERE certificate_id = $1',
    [certId]
  );
  if (!res.rows[0]) { console.error('not found'); process.exit(2); }
  const file = path.join(__dirname, '..', 'uploads', res.rows[0].document_path);

  const ocr = await ocrService.extractImageText(file);
  console.log('=== inferFields(primaryText) ===');
  console.log(JSON.stringify(ocrService.inferFields(ocr.primaryText)));

  console.log('\n=== sparseSecondOpinion text ===');
  const sparseText = await ocrService.sparseSecondOpinion(ocr.prepared);
  console.log(sparseText || '(failed)');
  console.log('=== inferFields(sparse) ===');
  console.log(JSON.stringify(sparseText ? ocrService.inferFields(sparseText) : null));

  const merged = await ocrService.extractFields(file, res.rows[0].document_mime || 'image/png');
  console.log('\n=== extractFields(final) ===');
  console.log(JSON.stringify(merged.fields));
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
