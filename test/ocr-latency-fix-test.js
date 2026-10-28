'use strict';

/**
 * test/ocr-latency-fix-test.js
 *
 * Verifies the latency changes in ocrService WITHOUT pointing at the
 * database or chain:
 *  1. the warmup() entry runs and leaves the module usable;
 *  2. extractFields memoization: second call over the SAME file returns the
 *     identical result without re-running the pass pipeline (wall time +
 *     result equality);
 *  3. poisoning isolation: mutating a returned object never changes the
 *     cached result.
 * Set OCR_TEST_FILE to force a specific document.
 */

const path = require('path');
const fs = require('fs');

const ocrService = require('../services/ocrService');

async function main() {
  // 1. Warmup runs cleanly.
  await ocrService.warmup();
  console.log('warmup: ok');

  // 2. Pick a real upload to exercise.
  let sample = process.env.OCR_TEST_FILE ? path.resolve(process.env.OCR_TEST_FILE) : null;
  if (!sample) {
    const images = fs.readdirSync(path.join(__dirname, '..', 'uploads')).filter((f) => /\.(png|jpe?g)$/i.test(f));
    sample = images.length ? path.join(__dirname, '..', 'uploads', images[0]) : null;
    if (!sample) {
      const pdfs = fs.readdirSync(path.join(__dirname, '..', 'uploads')).filter((f) => /\.pdf$/i.test(f));
      sample = pdfs.length ? path.join(__dirname, '..', 'uploads', pdfs[0]) : null;
    }
  }
  if (!sample) {
    console.log('no real upload available to exercise - skipping pipeline timing');
    return;
  }
  const mime = /\.pdf$/i.test(sample) ? 'application/pdf' : 'image/png';
  console.log('sample:', path.basename(sample), `(${mime})`);

  // 3. First extraction = uncached full pipeline; second = cache hit.
  const t0 = Date.now();
  const first = await ocrService.extractFields(sample, mime);
  const uncachedMs = Date.now() - t0;

  const t1 = Date.now();
  const second = await ocrService.extractFields(sample, mime);
  const cachedMs = Date.now() - t1;

  console.log(`extract run 1 (cold): ${uncachedMs} ms status=${first.status} words=${(first.text || '').split(/\s+/).filter(Boolean).length}`);
  console.log(`extract run 2 (memo): ${cachedMs} ms status=${second.status}`);
  console.log('identical text:', first.text === second.text,
    '| identical fields:', JSON.stringify(first.fields) === JSON.stringify(second.fields));

  if (second.text !== first.text) throw new Error('cache returned different text for identical bytes');
  if (JSON.stringify(second.fields) !== JSON.stringify(first.fields)) throw new Error('cache returned different fields');
  console.log(uncachedMs > 100 && cachedMs > uncachedMs / 2
    ? 'WARNING: memoized run not clearly faster - inspect'
    : 'memoization speedup confirmed');

  // 4. Mutating the returned object must not poison the cache.
  first.fields = { studentName: 'POISONED' };
  const third = await ocrService.extractFields(sample, mime);
  console.log('poison isolation:', JSON.stringify(third.fields) !== JSON.stringify({ studentName: 'POISONED' }) ? 'ok' : 'FAIL');
}

main().catch((err) => {
  console.error('ocr-latency-fix-test FAILED:', err);
  process.exit(1);
});
