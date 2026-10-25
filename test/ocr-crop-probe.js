'use strict';
// Probe: what do different crops of a failing image OCR at 3x + PSM 11?
require('dotenv').config();
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const path = require('path');

async function main() {
  const file = path.resolve(process.argv[2] || path.join('uploads', '1792856527843-32188a782766e4b91b7a023c1022d4f1.png'));
  const worker = await Tesseract.createWorker('eng', 1, {
    langPath: path.join('node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
    logger: () => {},
    errorHandler: () => {},
  });
  const meta = await sharp(file).metadata();
  console.log('image:', meta.width, 'x', meta.height);

  async function probe(label, region, scale) {
    let img = sharp(file);
    if (region) img = img.extract(region);
    const prepared = await img.grayscale().normalise()
      .resize({ width: Math.round((region ? region.width : meta.width) * scale), kernel: 'lanczos3' })
      .sharpen({ sigma: 1.2 }).png().toBuffer();
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const { data } = await worker.recognize(prepared);
    const text = (data.text || '').trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    console.log(`\n===== ${label} (w=${region ? region.width : meta.width} x${scale}, ${words} words) =====`);
    console.log(text.slice(0, 900));
  }

  const h = meta.height, w = meta.width;
  await probe('FULL 3x', null, 3);
  await probe('TOP 42%', { left: 0, top: 0, width: w, height: Math.round(h * 0.42) }, 3);
  await probe('BAND 40-58%', { left: 0, top: Math.round(h * 0.40), width: w, height: Math.round(h * 0.18) }, 3);
  await probe('BOTTOM 30%', { left: 0, top: Math.round(h * 0.70), width: w, height: Math.round(h * 0.30) }, 3);
  await worker.terminate();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
