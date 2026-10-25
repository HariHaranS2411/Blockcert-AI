'use strict';
require('dotenv').config();
const path = require('path');
const ocrService = require('../services/ocrService');
const { initDatabase, query } = require('../config/database');
initDatabase();
const T0 = Date.now();
const mark = (s) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`);
(async () => {
  const certId = process.argv[2];
  const row = (await query('SELECT document_path, document_mime FROM certificates WHERE certificate_id=$1', [certId])).rows[0];
  if (!row) { console.error('no such cert'); process.exit(1); }
  const abs = path.resolve('uploads', row.document_path);
  mark('extracting ' + abs + ' ' + row.document_mime);
  const t = Date.now();
  const result = await ocrService.extractFields(abs, row.document_mime);
  mark('extractFields done in ' + ((Date.now() - t) / 1000).toFixed(1) + 's, status=' + result.status);
  console.log('=== FIELDS ===');
  console.log(JSON.stringify(result.fields, null, 2));
  console.log('=== TEXT (' + (result.text || '').length + ' chars) ===');
  console.log(result.text || '(empty)');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
