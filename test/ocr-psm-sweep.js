'use strict';
/**
 * test/ocr-psm-sweep.js — measures which Tesseract page-segmentation mode
 * produces the most readable text for a given image (used to pick a better
 * default than the hardcoded PSM 3).
 *
 * Usage: node test/ocr-psm-sweep.js <file> [moreFiles...]
 */
const path = require('path');

async function main() {
  const Tesseract = require('tesseract.js');
  const langPath = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0');
  const worker = await Tesseract.createWorker('eng', 1, { langPath, logger: () => {}, errorHandler: () => {} });
  const files = process.argv.slice(2);
  const modes = ['3', '4', '6', '11', '12'];
  for (const file of files) {
    console.log('\n=== ' + path.basename(file));
    for (const mode of modes) {
      await worker.setParameters({ tessedit_pageseg_mode: mode });
      const { data } = await worker.recognize(path.resolve(file));
      const text = (data.text || '').trim();
      const words = text.split(/\s+/).filter(Boolean).length;
      const letters = (text.match(/[A-Za-z]/g) || []).length;
      const junkRatio = words ? ((text.match(/[^A-Za-z0-9\s.,:'\-/%()]/g) || []).length / Math.max(1, text.length)) : 1;
      console.log(
        `PSM ${mode.padEnd(2)} words=${String(words).padStart(4)} letters=${String(letters).padStart(5)} ` +
        `conf=${String(Math.round(data.confidence)).padStart(3)} junk=${junkRatio.toFixed(3)}`
      );
      if (process.env.SHOW) console.log(text.replace(/\n+/g, ' | ').slice(0, 400));
    }
  }
  await worker.terminate();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
