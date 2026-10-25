'use strict';
// One-shot: node test/ai-score-once.js <file> [mimetype] [certificateId]
// Prints the risk score / classification / checks the AI service returns for a document.
require('dotenv').config();
const path = require('path');
const ocrService = require('../services/ocrService');
const aiService = require('../services/aiService');

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node test/ai-score-once.js <file> [mimetype] [certificateId]');
    process.exit(2);
  }
  const abs = path.resolve(file);
  const mime = process.argv[3] || (abs.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png');
  const certId = process.argv[4] || null;

  const ocr = await ocrService.extractFields(abs, mime);
  console.log('OCR status:', ocr.status, '| chars:', (ocr.text || '').length);
  if (ocr.status !== 'completed') {
    console.log('OCR error:', ocr.error);
    process.exit(1);
  }

  const result = await aiService.analyzeDocument({
    ocrText: ocr.text,
    filePath: abs,
    mimetype: mime,
    certificateId: certId,
  });
  console.log('SCORE:', result.riskScore, '| CLASS:', result.classification);
  (result.checks || []).forEach((c) => console.log(`  [${c.status}] ${c.name} :: ${(c.note || '').slice(0, 170)}`));
  (result.findings || []).forEach((f) => console.log('  - ' + String(f).slice(0, 240)));
})().catch((e) => {
  console.error('FAILED:', e.code || '', e.message, e.cause && e.cause.message);
  process.exit(1);
});
