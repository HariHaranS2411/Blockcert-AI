'use strict';
// Time each OCR stage on a card: primary PSM3 @1800, then PSM11 @1800, then 3x top-crop PSM11.
require('dotenv').config();
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const path = require('path');
const now = () => Date.now();
(async () => {
  const file = path.resolve('uploads', '1792856527843-32188a782766e4b91b7a023c1022d4f1.png');
  const t0 = now();
  const worker = await Tesseract.createWorker('eng', 1, {
    langPath: path.join('node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
    logger: () => {},
    errorHandler: () => {},
  });
  console.log('worker init:', ((now() - t0) / 1000).toFixed(1) + 's');
  const meta = await sharp(file).metadata();
  const prep0 = now();
  const prepared = await sharp(file).grayscale().normalise()
    .resize({ width: 1800, kernel: 'lanczos3' }).sharpen({ sigma: 1.2 }).png().toBuffer();
  console.log('preprocess:', ((now() - prep0) / 1000).toFixed(1) + 's, out', (await sharp(prepared).metadata()).width + 'x' + (await sharp(prepared).metadata()).height);
  for (const psm of ['3', '11']) {
    const t = now();
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(prepared);
    const words = (data.text || '').split(/\s+/).filter(Boolean).length;
    console.log(`PSM ${psm} @1800: ${((now() - t) / 1000).toFixed(1)}s (${words} words)`);
  }
  const t1 = now();
  const crop = await sharp(file).extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * 0.42) })
    .grayscale().normalise().resize({ width: 1446, kernel: 'lanczos3' }).sharpen({ sigma: 1.2 }).png().toBuffer();
  const tp = now();
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  const r2 = await worker.recognize(crop);
  await worker.setParameters({ tessedit_pageseg_mode: '3' });
  console.log(`top-crop 3x PSM11: crop ${((tp - t1) / 1000).toFixed(1)}s + recognize ${((now() - tp) / 1000).toFixed(1)}s (${(r2.data.text||'').split(/\s+/).filter(Boolean).length} words)`);
  await worker.terminate();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
