'use strict';
// Scratch probe: exercise duplicateService.detectDuplicate / buildDuplicateCheck
// on real documents (no AI provider call).
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { initDatabase, query } = require('../config/database');
const ocrService = require('../services/ocrService');
const duplicateService = require('../services/duplicateService');

(async () => {
  initDatabase();
  const r = await query(
    `SELECT certificate_id, document_path, document_mime, student_name, registration_number, degree, marks, issue_date
       FROM certificates WHERE certificate_id IN ('CERT-2026-000020','CERT-2026-000004')`
  );
  const byId = Object.fromEntries(r.rows.map((row) => [row.certificate_id, row]));

  const original = path.join('uploads', byId['CERT-2026-000020'].document_path);
  const ocr = await ocrService.extractFields(original, byId['CERT-2026-000020'].document_mime);
  console.log('--- (1) original stored doc, as-is ---');
  const dup1 = await duplicateService.detectDuplicate({ filePath: original, mimetype: byId['CERT-2026-000020'].document_mime, text: ocr.text, fields: ocr.fields });
  console.log(JSON.stringify(dup1, null, 1));
  console.log('CHECK:', JSON.stringify(duplicateService.buildDuplicateCheck(dup1, 'CERT-2026-000020')));

  // (1b) re-encoded copy analyzed WITH the targeted certificateId (the real
  // certificate-details flow always passes one)
  console.log('--- (1b) re-encoded copy + targeted certificateId ---');
  const sharp1b = require('sharp');
  const reencoded1b = path.join('.freebuff', 'dup-reencode-targeted.png');
  await sharp1b(original).resize({ width: 1798 }).jpeg({ quality: 80 }).toFile(reencoded1b);
  const ocr1b = await ocrService.extractFields(reencoded1b, 'image/jpeg');
  const dup1b = await duplicateService.detectDuplicate({ filePath: reencoded1b, mimetype: 'image/jpeg', text: ocr1b.text, fields: ocr1b.fields, certificateId: 'CERT-2026-000020' });
  console.log(JSON.stringify({ level: dup1b.level, reference: dup1b.reference && dup1b.reference.certificateId, differences: dup1b.differences }, null, 1));
  console.log('CHECK:', JSON.stringify(duplicateService.buildDuplicateCheck(dup1b, 'CERT-2026-000020')));
  fs.unlinkSync(reencoded1b);

  // (2) re-encoded copy: same pixels, different bytes -> content-match path
  const sharp = require('sharp');
  const reencoded = path.join('.freebuff', 'dup-reencode.png');
  await sharp(original).resize({ width: 1799 }).png({ compressionLevel: 9 }).toFile(reencoded);
  const ocr2 = await ocrService.extractFields(reencoded, 'image/png');
  console.log('--- (2) re-encoded copy (different bytes) ---');
  const dup2 = await duplicateService.detectDuplicate({ filePath: reencoded, mimetype: 'image/png', text: ocr2.text, fields: ocr2.fields });
  console.log(JSON.stringify({ level: dup2.level, reference: dup2.reference, differences: dup2.differences }, null, 1));
  console.log('CHECK:', JSON.stringify(duplicateService.buildDuplicateCheck(dup2, 'CERT-2026-000020')));
  fs.unlinkSync(reencoded);

  // (3) byte-exact copy analyzed under ANOTHER certificate id
  console.log('--- (3) same bytes, wrong certificate context ---');
  console.log('CHECK:', JSON.stringify(duplicateService.buildDuplicateCheck(dup1, 'CERT-2026-000004')));

  // (4) standalone foreign doc (no registered match): use one of the unreadable junk uploads
  const junk = fs.existsSync('uploads') ? fs.readdirSync('uploads').slice(0, 50) : [];
  console.log('--- (4) evidence building with synthetic differences ---');
  const fabricated = { level: 'content-match', reference: { certificateId: 'CERT-2026-000020', status: 'ACTIVE', issueDate: '2021-05-12', studentName: 'PRADIP SENAPATI', registrationNumber: '210504729', degree: 'BE', marks: '7.5' }, differences: [{ field: 'marks', printed: '8.75', official: '7.5' }] };
  console.log(JSON.stringify(duplicateService.evidenceForModel(fabricated), null, 1));
  console.log('junk docs available:', junk.length);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
