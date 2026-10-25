'use strict';
/**
 * test/ocr-preprocess-test.js — does preprocessing + a different page
 * segmentation mode make small certificate scans readable?
 *
 * Compares raw OCR (today's pipeline: PSM 3, no preprocessing) against
 * grayscale + auto-levels + upscale + sharpen with PSM 3 / 6 / 11, and
 * reports how many known field values become recoverable.
 *
 * Usage: node test/ocr-preprocess-test.js <file> [moreFiles...]
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

function scoreText(text, probes) {
  const found = probes.filter((p) => new RegExp(p, 'i').test(text));
  return { hits: found.length, total: probes.length, found };
}

async function main() {
  const Tesseract = require('tesseract.js');
  const langPath = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0');
  const worker = await Tesseract.createWorker('eng', 1, { langPath, logger: () => {}, errorHandler: () => {} });

  for (const file of process.argv.slice(2)) {
    const abs = path.resolve(file);
    const raw = fs.readFileSync(abs);

    // Field probes that exist in the DB for these documents (name/reg/marks).
    const probes = process.env.PROBES ? process.env.PROBES.split('|') : [];
    const meta = await sharp(raw).metadata().catch(() => ({}));
    console.log(`\n=== ${path.basename(file)}  ${meta.width || '?'}x${meta.height || '?'}`);

    const variants = [
      ['raw        PSM3', raw, '3'],
      ['raw        PSM11', raw, '11'],
      [
        'preproc    PSM3',
        await sharp(raw)
          .grayscale()
          .normalise()
          .resize({ width: 1800, kernel: 'lanczos3', withoutEnlargement: false })
          .sharpen({ sigma: 1.2 })
          .png()
          .toBuffer(),
        '3',
      ],
      [
        'preproc    PSM11',
        await sharp(raw)
          .grayscale()
          .normalise()
          .resize({ width: 1800, kernel: 'lanczos3', withoutEnlargement: false })
          .sharpen({ sigma: 1.2 })
          .png()
          .toBuffer(),
        '11',
      ],
    ];

    for (const [label, buf, psm] of variants) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(buf);
      const text = (data.text || '').trim();
      const words = text.split(/\s+/).filter(Boolean).length;
      const letters = (text.match(/[A-Za-z]/g) || []).length;
      const probe = probes.length ? scoreText(text, probes) : null;
      console.log(
        `${label} words=${String(words).padStart(4)} letters=${String(letters).padStart(5)} ` +
          `conf=${String(Math.round(data.confidence)).padStart(3)}` +
          (probe ? ` probes=${probe.hits}/${probe.total}` : '')
      );
      if (process.env.SHOW) console.log('    ' + text.replace(/\s*\n\s*/g, ' | ').slice(0, 500));
    }
  }
  await worker.terminate();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
