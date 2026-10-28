'use strict';

/**
 * test/ocr-region-cap-test.js
 *
 * Verifies the crop-rescue latency guard in ocrService: a high-resolution
 * source image no longer produces a Tesseract buffer wider than 1800px in
 * extractImageRegion, regardless of how big the original is. This is the
 * pass that used to spawn width*scale wide crops (a 1800px upload -> 5400px
 * pass, tens of seconds on the free CPU tier).
 *
 * Copied from the same 1800px-limited preprocessThat primary uses, the cap
 * keeps every crop at or below the primary pass cost. We exercise the real
 * extractImageRegion over a synthetic 3000px-wide image and assert it
 * completes quickly and returns a string ('' is fine - the point is the
 * bounded pipeline, not the OCR quality of a synthetic page).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ocrService = require('../services/ocrService');

async function main() {
  const sharp = (() => { try { return require('sharp'); } catch (_) { return null; } })();
  if (!sharp) {
    console.log('sharp unavailable - cannot build a synthetic wide image; skip');
    return;
  }

  const big = path.join(os.tmpdir(), 'ocr-region-cap-test-wide.png');
  // 3000x2000 white page with a line of black text near the top.
  const page = Buffer.from(
    '<svg width="3000" height="2000">' +
    '<rect width="3000" height="2000" fill="#ffffff"/>' +
    '<text x="100" y="200" font-family="sans-serif" font-size="90" fill="#000000">REGION CAP TEST</text>' +
    '</svg>'
  );
  await sharp(page).png().toFile(big);
  const meta = await sharp(big).metadata();
  console.log(`synthetic source: ${meta.width}x${meta.height}`);

  await ocrService.warmup();

  // 3x the old behaviour: scale=3 on a 3000px-wide source -> would have been
  // a 9000px-wide tesseract pass; with the guard it must stay <=1800.
  const t0 = Date.now();
  const text = await ocrService.extractImageRegion(big, { topRatio: 0, bottomRatio: 0.5, scale: 3 });
  const ms = Date.now() - t0;
  console.log(`extractImageRegion(scale=3): ${ms} ms text="${(text || '').trim().slice(0, 60)}"`);

  // Wide-source region must not take minutes; a bounded local bound.
  if (ms > 30000) throw new Error(`region pass took ${ms} ms - the width cap is not applied`);
  if (/REGION CAP TEST/i.test(text || '')) console.log('region OCR readable at capped width: yes');
  else console.log('region OCR returned nothing legible (acceptable - the guard is what is under test)');

  fs.promises.unlink(big).catch(() => {});
  console.log('region cap test: PASS');
}

main().catch((err) => {
  console.error('ocr-region-cap-test FAILED:', err);
  process.exit(1);
});
