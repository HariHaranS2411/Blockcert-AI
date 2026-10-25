'use strict';
/* Scratch probe: print primary and sparse PSM 11 text for a stored image
 * document so degree-candidate selection can be diagnosed against the real
 * OCR output. Usage: node test/probe-sparse-text.js CERT-2026-000025
 */
require('dotenv').config();
const path = require('path');
const ocrService = require('../services/ocrService');

async function main() {
  const certId = process.argv[2];
  if (!certId) { console.error('usage: node test/probe-sparse-text.js CERT-...'); process.exit(2); }
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
  console.log(`=== PRIMARY (words=${ocr.primaryText.split(/\s+/).filter(Boolean).length}) ===`);
  console.log(ocr.primaryText);
  if (ocr.sparseText !== null) {
    console.log(`\n=== SPARSE PSM11 (words=${ocr.sparseText.split(/\s+/).filter(Boolean).length}) ===`);
    console.log(ocr.sparseText);
    console.log('\n=== inferFields(sparseText) ===');
    console.log(JSON.stringify(ocrService.inferFields(ocr.sparseText)));
  } else {
    console.log('\n(no sparse pass: primary had >= 20 words)');
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
