'use strict';
require('dotenv').config();
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const path = require('path');
const ocrService = require('../services/ocrService');
(async () => {
  const file = path.resolve('uploads', '1792856527843-32188a782766e4b91b7a023c1022d4f1.png');
  const prepared = await sharp(file).grayscale().normalise()
    .resize({ width: 1800, kernel: 'lanczos3' }).sharpen({ sigma: 1.2 }).png().toBuffer();
  const worker = await Tesseract.createWorker('eng', 1, {
    langPath: path.join('node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
    logger: () => {}, errorHandler: () => {},
  });
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  const { data } = await worker.recognize(prepared);
  const text = (data.text || '').trim();
  console.log('=== SPARSE @1800 (first 40 lines) ===');
  console.log(text.split('\n').slice(0, 40).join('\n'));
  console.log('=== inferFields on sparse ===');
  console.log(JSON.stringify(ocrService.inferFields(text), null, 2));
  await worker.terminate();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
