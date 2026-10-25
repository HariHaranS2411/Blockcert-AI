'use strict';
// Experiment: does the model weigh platform duplicate evidence correctly?
//   case A: differences that are known issuance/DB artifacts (degree B.Tech.
//           vs BE, date 20-08-2024 vs 2026-10-11) -> expect low score.
//   case B: wholesale marks replacement (8.75 vs official 7.5) -> expect
//           Suspicious (31-70).
require('dotenv').config();
const aiService = require('../services/aiService');

const OCR_TEXT = `ANNA UNIVERSITY, CHENNAI - 600 025
B.E. / B.Tech. DEGREE EXAMINATIONS
Name of the Candidate: PARASAKTHIKUMAR K
Register Number: TE1421242040
B.Tech. Computer Science and Engineering
Date of Issue: 20-08-2024
CGPA 8.1
Controller of Examinations`;

const CASE_A = [
  'PLATFORM RECORD MATCH: this upload reproduces the document registered for certificate CERT-2026-000020 (status active, issued 2026-10-11).',
  'Official record values: student name "prasanth"; registration number "24CSE00129"; degree "BE"; marks "7.5".',
  'Printed values in THIS upload that disagree with the official record:',
  '- degree: printed "B.Tech." vs official "BE"',
  '- issue date: printed "20-08-2024" vs official "2026-10-11"',
  '',
  'Weighing rule: character-level slips, a missing final letter or case/formatting differences are usually OCR noise or typing errors at issuance and are NOT alterations by themselves. Wholesale replacement of a value (a different name, different marks, a different registration number) IS concrete textual evidence of alteration: quote the replaced values from the official record.',
];

const CASE_B = CASE_A.slice(0, 3)
  .concat([
    '- marks: printed "8.75" vs official "7.5"',
    '- registration number: printed "TE1421252040" vs official "24CSE00129"',
  ])
  .concat(CASE_A.slice(3 + 2));

// wait: case B list got messy - rebuild explicitly
const CASE_B_CLEAN = [
  CASE_A[0],
  CASE_A[1],
  'Printed values in THIS upload that disagree with the official record:',
  '- marks: printed "8.75" vs official "7.5"',
  '- registration number: printed "TE1421252040" vs official "24CSE00129"',
  '',
  `Weighing rule: character-level slips, a missing final letter or case/formatting differences are usually OCR noise or typing errors at issuance and are NOT alterations by themselves. Wholesale replacement of a value (a different name, different marks, a different registration number) IS concrete textual evidence of alteration: quote the replaced values from the official record.`,
];

const CASE_NAME_GAP = [
  CASE_A[0],
  CASE_A[1],
  'Printed values in THIS upload that disagree with the official record:',
  '- name: printed "PARASAKTHIKUMAR K" vs official "PRASANTH"',
  '',
  `Weighing rule: character-level slips, a missing final letter or case/formatting differences are usually OCR noise or typing errors at issuance and are NOT alterations by themselves. Wholesale replacement of a value (a different name, different marks, a different registration number) IS concrete textual evidence of alteration: quote the replaced values from the official record.`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('--- case A: artifact differences (expect LOW score) ---');
  let r = await aiService.analyzeDocument({ ocrText: OCR_TEXT, filePath: __filename, mimetype: 'application/pdf', duplicateEvidence: CASE_A });
  console.log('score:', r.riskScore, '| class:', r.classification, '| model:', r.model);
  (r.findings || []).slice(0, 3).forEach((f) => console.log('  -', String(f).slice(0, 140)));
  await sleep(1500);

  console.log('--- case B: marks + reg swapped (expect SUSPICIOUS) ---');
  r = await aiService.analyzeDocument({ ocrText: OCR_TEXT, filePath: __filename, mimetype: 'application/pdf', duplicateEvidence: CASE_B_CLEAN });
  console.log('score:', r.riskScore, '| class:', r.classification, '| model:', r.model);
  (r.findings || []).slice(0, 4).forEach((f) => console.log('  -', String(f).slice(0, 140)));
  await sleep(1500);

  console.log('--- case C: name wholesale swapped (expect SUSPICIOUS) ---');
  r = await aiService.analyzeDocument({ ocrText: OCR_TEXT, filePath: __filename, mimetype: 'application/pdf', duplicateEvidence: CASE_NAME_GAP });
  console.log('score:', r.riskScore, '| class:', r.classification, '| model:', r.model);
  (r.findings || []).slice(0, 4).forEach((f) => console.log('  -', String(f).slice(0, 140)));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message, e.detail || ''); process.exit(1); });
