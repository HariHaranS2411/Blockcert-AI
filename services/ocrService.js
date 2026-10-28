'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Real OCR / text extraction from the uploaded document.
 * PDFs are parsed with the modern pdfjs-dist engine; images are run through
 * Tesseract.js. Never invents values: when insufficient text is found it
 * reports so.
 *
 * NOTE: we previously used the `pdf-parse` package, but it bundles a 2018-era
 * pdf.js (v1.9.426 / v1.10.100) that throws "bad XRef entry" on many valid
 * certificate PDFs, which broke certificate verification before it ever
 * reached the blockchain. pdfjs-dist parses those files correctly.
 */

let pdfjsPromise = null;

/** Lazily load the ESM pdfjs-dist legacy build once (CJS host via import()). */
function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

let workerPromise = null;

/**
 * Lazily create ONE warm Tesseract worker and reuse it for every image OCR
 * request. Language data ships locally via @tesseract.js-data/eng, so no
 * multi-megabyte CDN download happens on the first (or any) request.
 * A malformed image can abort the worker's WASM module; when that happens
 * the worker is discarded and a fresh one is created on the next call
 * (with a small backoff) so one bad upload cannot take OCR - or the
 * server - permanently down.
 */
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = require('tesseract.js');
      const langPath = path.join(
        __dirname,
        '..',
        'node_modules',
        '@tesseract.js-data',
        'eng',
        '4.0.0'
      );
      return Tesseract.createWorker('eng', 1, {
        langPath,
        logger: () => {},
        errorHandler: () => {},
      });
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Warm the extraction plumbing in the background (server startup) so the
 * FIRST real upload after a cold start does not pay the one-off costs:
 * Tesseract worker creation + language/wasm load, first pdfjs-dist import,
 * first sharp load. Creates nothing on failure - the normal lazy paths
 * simply take over at first use, exactly as before warmup existed.
 */
async function warmup() {
  try {
    await getWorker();
    console.log('[ocr] warmed: tesseract worker ready');
  } catch (err) {
    console.warn('[ocr] warmup: worker not ready yet -', err.message);
  }
  try { await getPdfjs(); } catch (_) { /* pdf imports lazily on first PDF as before */ }
  getSharp();
}

function discardWorker() {
  // Replace the cached promise so the next call builds a fresh worker;
  // swallow any rejection from the discarded one so it cannot become an
  // unhandled rejection and crash the process.
  const old = workerPromise;
  workerPromise = null;
  if (old && typeof old.catch === 'function') {
    old.catch(() => {});
  }
}

/**
 * Primary image OCR. Runs PSM 3 on the preprocessed buffer (note: the
 * buffer is a 1800px-wide upscaled scan) and, when the primary looks thin
 * (<20 words - table-ruling shatters PSM 3's layout analysis), a sparse
 * PSM 11 pass on the SAME buffer. Returns both texts plus the prepared
 * buffer so extractFields can run ONE more PSM 11 pass for field merging
 * without re-reading or re-resizing the image.
 */
async function extractImageText(filePath) {
  try {
    const worker = await getWorker();
    const original = await fs.promises.readFile(filePath);
    const prepared = await preprocessForOcr(original);

    const recognize = async (psm) => {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(prepared);
      const t = data && data.text ? data.text.trim() : '';
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
      return t;
    };

    const primaryText = await recognize('3');
    const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;
    const primaryWords = wordCount(primaryText);
    const sparseText = primaryWords < 20 ? await recognize('11') : null;
    const text =
      sparseText && wordCount(sparseText) > primaryWords ? sparseText : primaryText;
    return { text, primaryText, sparseText, prepared };
  } catch (err) {
    // The worker's WASM state may be poisoned after an abort - drop it so
    // the next request starts clean instead of failing forever.
    discardWorker();
    throw err;
  }
}

/** One sparse PSM 11 recognize over an already-prepared buffer (no extra
 *  resize: the buffer is already 1800px, ~3.7x of a 482px phone scan). Used
 *  as a "second opinion" when field merging on the primary text leaves core
 *  fields missing. Returns '' on failure - callers merge nothing. */
async function sparseSecondOpinion(prepared) {
  if (!prepared) return '';
  try {
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const { data } = await worker.recognize(prepared);
    return data && data.text ? data.text.trim() : '';
  } catch (err) {
    discardWorker();
    return '';
  }
}

/**
 * Generic crop-rescue pass: OCR a REGION of the page at `scale`x the
 * original width with sparse text (PSM 11), where the primary 1800px pass
 * shreds the print. Used for the page top (name/register rows) and the
 * page bottom (CGPA/grade rows, which print below the course table).
 * Returns '' when sharp is unavailable or anything fails - callers treat
 * that as "no rescue".
 */
async function extractImageRegion(filePath, { topRatio = 0, bottomRatio = 1, scale = 3 } = {}) {
  const sharp = getSharp();
  if (!sharp) return '';
  /* Latency guard: the crop used to upscale to width*width WITHOUT a cap,
     so a 1800px-wide upload spawned a 5400px-wide Tesseract pass (tens of
     seconds on the free-tier CPU). Cap at the same 1800px the primary pass
     uses - phone-shot crops (~500px * 3 = ~1500px) are untouched, exactly
     the regime these rescues were measured on. */
  const CROP_MAX_WIDTH = 1800;
  try {
    const original = await fs.promises.readFile(filePath);
    const meta = await sharp(original).metadata();
    if (!meta.width || !meta.height) return '';
    const top = Math.round(meta.height * topRatio);
    const height = Math.max(40, Math.round(meta.height * (bottomRatio - topRatio)));
    if (height < 40 || top + height > meta.height) return '';
    const prepared = await sharp(original)
      .extract({ left: 0, top, width: meta.width, height })
      .grayscale()
      .normalise()
      .resize({ width: Math.min(Math.round(meta.width * scale), CROP_MAX_WIDTH), kernel: 'lanczos3' })
      .sharpen({ sigma: 1.2 })
      .png()
      .toBuffer();
    const worker = await getWorker();
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const { data } = await worker.recognize(prepared);
      return data && data.text ? data.text.trim() : '';
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
    }
  } catch (err) {
    discardWorker();
    return '';
  }
}

let sharpModule;

/** Lazily require sharp; `false` means it is unavailable (never throws). */
function getSharp() {
  if (sharpModule === undefined) {
    try { sharpModule = require('sharp'); } catch (_) { sharpModule = false; }
  }
  return sharpModule || null;
}

/**
 * Phone/screenshot scans of certificates are routinely ~500px wide (~72
 * DPI) - far below what Tesseract's LSTM expects. Measured on this corpus
 * (test/ocr-preprocess-test.js): a 447x592 grade card yielded 18 words raw
 * and 212 after grayscale + auto-levels + lanczos upscale + light sharpen;
 * a 532x706 scan rose from confidence 63 to 83.
 *
 * Returns the original buffer when sharp is missing or rejects the file, so
 * OCR degrades to the previous behaviour instead of failing.
 */
async function preprocessForOcr(buffer) {
  const sharp = getSharp();
  if (!sharp) return buffer;
  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 0;
    if (!width || !meta.height) return buffer;
    const pipeline = sharp(buffer).grayscale().normalise();
    // Only enlarge small scans; never shrink a high-resolution upload.
    if (width < 1800) pipeline.resize({ width: 1800, kernel: 'lanczos3' });
    const out = await pipeline.sharpen({ sigma: 1.2 }).png().toBuffer();
    return out && out.length ? out : buffer;
  } catch (_) {
    return buffer;
  }
}

/**
 * Reconstruct plain text from pdf.js textContent items.
 * Items on the same visual row (same baseline Y, within tolerance) are
 * joined with spaces; a change in Y starts a new line, and a large vertical
 * gap emits a blank line - so the downstream line-based field inference sees
 * the same kind of line structure it would from a real marksheet.
 */
function itemsToText(items) {
  const rows = [];
  let current = null;
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const y = item.transform && item.transform.length >= 6 ? item.transform[5] : null;
    if (!current || (y !== null && current.y !== null && Math.abs(y - current.y) > 2)) {
      current = { y, parts: [] };
      rows.push(current);
    }
    if (item.str) current.parts.push(item.str);
    if (item.hasEOL) current = null;
  }
  let lastY = null;
  const lines = [];
  for (const row of rows) {
    const line = row.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (lastY !== null && row.y !== null && lastY - row.y > 14) lines.push('');
    if (line) lines.push(line);
    if (row.y !== null) lastY = row.y;
  }
  return lines.join('\n');
}

async function extractPdfText(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const pdfjsLib = await getPdfjs();
  // pdf.js takes ownership of the ArrayBuffer it is given, so hand it a copy
  // to avoid detaching our own buffer.
  const data = new Uint8Array(buffer.slice(0));
  const doc = await pdfjsLib.getDocument({
    data,
    // Node has no canvas/DOM: disable font-face fetching and eval so parsing
    // stays offline, deterministic and safe for untrusted uploads.
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
  }).promise;

  let out = '';
  try {
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      out += itemsToText(content.items) + '\n';
      if (typeof page.cleanup === 'function') page.cleanup();
    }
  } finally {
    if (typeof doc.destroy === 'function') await doc.destroy().catch(() => {});
  }
  return out.trim();
}

/*
 * Short-lived memoization of extractFields, keyed by the SHA-256 of the file
 * CONTENT (not the path). Real patterns this serves:
 *  - issuance: the review screen extracts a document via /api/ocr/extract,
 *    then the browser re-uploads the SAME file to /api/certificates, which
 *    re-runs the whole tesseract pipeline on byte-identical content;
 *  - verify-then-analyze flows on the same document.
 * OCR of byte-identical input is deterministic, so a cached result is the
 * exact result a fresh pass would produce. TTL 10 min and bounded size;
 * cache misses simply fall through to the normal extraction.
 * A SHALLOW CLONE is returned so callers can never mutate a cached result:
 * every consumer only reads {status, text, fields, error} directly.
 */
const EXTRACT_CACHE_TTL_MS = 10 * 60 * 1000;
const EXTRACT_CACHE_MAX = 20;
const extractCache = new Map(); // digest -> { expires, value }

async function fileDigest(filePath) {
  const buf = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function cacheGet(digest) {
  const hit = extractCache.get(digest);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    extractCache.delete(digest);
    return null;
  }
  // LRU order refresh, then hand out a copy.
  extractCache.delete(digest);
  extractCache.set(digest, hit);
  return { ...hit.value };
}

function cachePut(digest, value) {
  // Never cache a soft-read failure (file vanished mid-read): the next
  // attempt may hit an actually existing file again.
  if (!value || value.status === 'failed') return;
  extractCache.set(digest, { expires: Date.now() + EXTRACT_CACHE_TTL_MS, value });
  while (extractCache.size > EXTRACT_CACHE_MAX) {
    const oldest = extractCache.keys().next().value;
    extractCache.delete(oldest);
  }
}

/**
 * Extract raw text plus best-effort field suggestions from a real document.
 * Returns { status: 'completed' | 'insufficient' | 'failed', text, fields, error }
 */
async function extractFields(filePath, mimetype) {
  let digest = null;
  try {
    digest = await fileDigest(filePath);
  } catch (err) {
    return { status: 'failed', text: '', fields: {}, error: err.message || 'Could not read this document.' };
  }
  const cached = cacheGet(digest);
  if (cached) return cached;
  const result = await extractFieldsUncached(filePath, mimetype);
  cachePut(digest, result);
  return { ...result };
}

async function extractFieldsUncached(filePath, mimetype) {
  const fields = {};
  let text = '';
  let imagePrepared = null;
  let imageSparse = null; // sparse PSM 11 text when extractImageText already ran it
  const timings = { primary: 0, sparse: 0, top: 0, bottom: 0, kind: '' };
  const ext0 = Date.now();
  try {
    if (mimetype === 'application/pdf') {
      timings.kind = 'pdf';
      text = await extractPdfText(filePath);
    } else {
      timings.kind = 'image';
      const p0 = Date.now();
      const ocr = await extractImageText(filePath);
      timings.primary = Date.now() - p0;
      text = ocr.text;
      imagePrepared = ocr.prepared;
      imageSparse = ocr.sparseText;
    }
  } catch (err) {
    return { status: 'failed', text: '', fields, error: err.message || 'Text extraction failed.' };
  }

  const cleaned = text.replace(/\r/g, '');
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) {
    return {
      status: 'insufficient',
      text: cleaned,
      fields,
      error: 'Unable to extract sufficient text from this document.',
    };
  }

  Object.assign(fields, inferFields(cleaned, { rejectBareShorthandOnly: true }));

  /* Rescue passes: scanned certificates routinely shred different parts of
     the page on the PRIMARY pass even though they print legibly. Measured on
     a 482x705 Anna University grade sheet (CERT-2026-000025): the header row
     ("ANNA UNIVERSITY, CHENNAI - 25", "M.E. DEGREE EXAMINATIONS") and the
     CGPA summary were unparseable in the primary 1800px pass - but a sparse
     PSM 11 pass on the SAME buffer read the header, degree and candidate
     rows, and a BOTTOM-CROP 3x pass read "Cumulative Grade Point Average
     (CGPA)" with the value. Merge ONLY keys the primary pass could not
     find, so a rescue can never overwrite a value the primary already
     extracted. One extra pass maximum per purpose, ordered cheapest-first:
     (1) sparse second opinion on the SAME prepared buffer (no resize),
     (2) targeted TOP crop for name / register rows,
     (3) targeted BOTTOM crop for the marks sum. PDFs skip this entirely
     (they already carry a text layer). */
  if (mimetype !== 'application/pdf') {
    const CORE_KEYS = ['studentName', 'registrationNumber', 'institution', 'degree', 'academicYear'];
    const missingCore = CORE_KEYS.filter((k) => fields[k] === undefined);
    const marksCallable = fields.marks === undefined &&
      /\b(?:cgpa|sgpa|gpa|grade\s*point|percentage|grade)\b/i.test(cleaned);
    if (missingCore.length && imageSparse === null) {
      // Sparse "second opinion" on the SAME prepared buffer: PSM 11 ignores
      // table ruling that shatters PSM 3's layout analysis. Measured
      // (CERT-2026-000025): sparse output has NO line structure, so its
      // studentName can be a bare label fragment ("CANDIDATE") while the
      // primary found none — names come only from the structured TOP crop
      // below; the sparse pass contributes institution/degree/reg/session.
      const s0 = Date.now();
      const sparseText = await sparseSecondOpinion(imagePrepared);
      timings.sparse = Date.now() - s0;
      if (sparseText) {
        const rescued = inferFields(sparseText);
        for (const k of missingCore) {
          if (k === 'studentName') continue;
          if (!rescued[k]) continue;
          if (k === 'institution' && rescued[k].length < 5) continue;
          // Two-letter candidates are junk everywhere except the standard
          // credential shorthands the sparse pass legitimately finds ("ME",
          // "BE" - full "M.E." would be a lucky line anyway).
          if (rescued[k].length < 3 && !/^[bm]e$/i.test(String(rescued[k]))) continue;
          fields[k] = rescued[k];
        }
      }
    }
    if (fields.studentName === undefined || fields.registrationNumber === undefined) {
      // Targeted TOP-crop 3x rescue for the name / register rows.
      const t0 = Date.now();
      const rescueText = await extractImageRegion(filePath, { topRatio: 0, bottomRatio: 0.42 });
      timings.top = Date.now() - t0;
      if (rescueText) {
        const rescued = inferFields(rescueText);
        for (const k of ['studentName', 'registrationNumber']) {
          if (fields[k] === undefined && rescued[k]) fields[k] = rescued[k];
        }
      }
    }
    if (fields.marks === undefined && marksCallable) {
      // CGPA/credits summary prints at the page bottom, below the courses.
      const b0 = Date.now();
      const bottomText = await extractImageRegion(filePath, { topRatio: 0.70, bottomRatio: 1, scale: 3 });
      timings.bottom = Date.now() - b0;
      if (bottomText) {
        const rescuedMarks = inferFields(bottomText);
        if (rescuedMarks.marks) fields.marks = rescuedMarks.marks;
      }
    }
  }

  console.log(`[ocr] extract ${timings.kind}: total ${Date.now() - ext0} ms (primary ${timings.primary}, sparse ${timings.sparse}, top ${timings.top}, bottom ${timings.bottom}, fields ${Object.keys(fields).length})`);

  return { status: 'completed', text: cleaned, fields, error: null };
}

/* OCR noise commonly printed around label/table cells: pipes, brackets,
   dashes, colons, stray symbols. Pure digit tokens like "2024" are NOT
   noise by themselves - exam years and marks are valid values. */
const PURE_NOISE = /^[|$#+=~^`_*·•—\-.,\s]+$/;

/** Tokens that almost always mark the END of a name/value in a table row
    layout, e.g. "HARI HARAN Semester 4 | Degree ...". */
const VALUE_TERMINATORS = /^(semester|term|regulation|result|month|date|session|degree|branch|speciali[sz]ation|regist|reg\b|roll|enrol|enroll|dob|contact|place|issued|signature|controller|status|exam|examination|centre|center|marks|grade|subject|title|credits|internal|external|total|sl\.?no|faculty|father|mother|guardian)/i;

/** Strip leading junk (OCR border characters, serial numbers, stray `$` etc.)
    and trailing table labels from an extracted value. */
function cleanField(value) {
  let v = String(value);
  // Remove leading pipe/border junk and stray symbols.
  v = v.replace(/^[|$#+=^`~_·•—\-\s]+/, '');
  const parts = v.split(/\s+/);
  const keep = [];
  for (const p of parts) {
    if (PURE_NOISE.test(p)) continue;
    if (keep.length > 0 && VALUE_TERMINATORS.test(p)) break;
    keep.push(p);
  }
  v = keep.join(' ');
  // Drop trailing junk chars and collapse whitespace.
  v = v.replace(/[|]$/, '').replace(/\s+/g, ' ').trim();
  return v;
}

/**
 * Extract the student name from OCR text. Prefers the content AFTER a label
 * like "Name of the Candidate" / "Student Name" / "NAME" and stops at the
 * next table label (Semester, Degree, Result, etc.), pipes, or digits.
 */
function extractStudentName(lines, text) {
  const labelRegex = /(?:name\s*of\s*(?:the\s*)?(?:student|candidate|recipient)|(?:student|candidate|applicant)'?s?\s*name|^\s*name\b)\s*[:\-]?\s*(.*)$/i;

  // 0) Certificate holder: generated certificates print the name UNLABELLED
  //    on the line after "This is to certify that".
  const leadIn = /^(?:this\s+is\s+to\s+certify\s+that|we\s+hereby\s+certify\s+that|it\s+is\s+certified\s+that|certified\s+that|this\s+certificate\s+is\s+presented\s+to|is\s+presented\s+to|is\s+awarded\s+to|awarded\s+to|proudly\s+presented\s+to)\s*[:\-]?\s*(.*)$/i;
  const leadOut = /^(?:has|have|is|was|were|completed|the|this|his|her|their|of|to|in|and|with)\b/i;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(leadIn);
    if (!m) continue;
    const sameLine = (m[1] || '').trim();
    if (sameLine && !leadOut.test(sameLine)) {
      const c = cleanName(sameLine);
      if (c) return c;
    }
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
      if (leadOut.test(lines[j].trim())) break;
      const c = cleanName(lines[j]);
      if (c) return c;
    }
  }

  // 0b) The line immediately BEFORE a "has completed ... / was awarded ..."
  //     line is the holder.
  const award = /^(?:has\s+completed|have\s+completed|completed|was\s+awarded|has\s+been\s+awarded|graduated|passed)/i;
  for (let i = 1; i < lines.length; i += 1) {
    if (!award.test(lines[i].trim())) continue;
    for (let j = i - 1; j >= Math.max(0, i - 3); j -= 1) {
      if (leadOut.test(lines[j].trim())) break;
      const c = cleanName(lines[j]);
      if (c) return c;
    }
  }

  // 0c) Table-row layout: "J PARASAKTHEUMAR K REGESTERNO| TZ141242040" —
  //     the holder name sits BEFORE a (possibly OCR-mangled) registration
  //     label on the same row. Header tokens (month/year/folio) disqualify
  //     the row so serial-number headers never leak in as a name.
  const regRowLabel = /\b(?:regis[a-z]*|regest[a-z]*)/i;
  for (const line of lines) {
    const idx = line.search(regRowLabel);
    if (idx < 1) continue;
    const pre = line.slice(0, idx);
    if (/(?:month|year|exam|folio|controller|dept)/i.test(pre)) continue;
    // A row whose text before the register label already carries a NAME
    // label ("Student's Name : Sachin Registration No, ...") belongs to the
    // labelled path below — not to the unlabelled-row heuristic.
    if (/\bname\b/i.test(pre)) continue;
    const toks = pre.replace(/[|=—=<>\[\](){}]/g, ' ').trim().split(/\s+/).filter(Boolean);
    while (toks.length && (/^\d/.test(toks[0]) || /^[^A-Za-z]+$/.test(toks[0]) || /^[A-Za-z]$/.test(toks[0]) || /^[a-z]{1,2}$/.test(toks[0]))) toks.shift();
    const cand = cleanName(toks.join(' '));
    if (cand) return cand;
  }

  // 1) Same-line after label (preferred).
  for (const line of lines) {
    const m = line.match(labelRegex);
    if (m && m[1] && m[1].trim().length >= 3) {
      const cleaned = cleanName(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // 2) The NEXT non-empty line after a label-only line.
  for (let i = 0; i < lines.length; i += 1) {
    if (/^(?:name\s*of\s*(?:the\s*)?(?:student|candidate|recipient)|(?:student|candidate)\s*name|name)\b(?:\s*of\b|\s*the\b|\s*of\s*the\b)*\s*[:\-]?\s*$/i.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const cand = cleanName(lines[j]);
        if (cand) return cand;
      }
    }
  }

  // 3) Generic full-text fallback with the more careful cleaner.
  const m = text.match(/(?:name\s*of\s*(?:the\s*)?(?:student|candidate|recipient)|student\s*name|candidate\s*name)\s*[:\-]?\s*([^\n]{3,120})/i);
  if (m) {
    return cleanName(m[1]);
  }
  return null;
}

/** Clean a raw candidate name: strip junk tokens, stop at table labels,
    remove stray symbols like `$` glued to the first name. */
function cleanName(raw) {
  let s = String(raw).trim();
  if (!s) return '';

  /* Shattered table labels can leak into a candidate (label "NAME OF THE"
     on its own OCR line captures "OF THE" before the real name value on the
     next line). Strip well-known leading label fragments so the residue
     starts at the first real name token. */
  s = s.replace(/^(?:(?:name|candidate|student|recipient|of|the)\b\s*)+/i, '');
  if (!s) return '';

  const tokens = s.split(/\s+/);
  const kept = [];
  for (const tok of tokens) {
    if (VALUE_TERMINATORS.test(tok)) break;
    // Sentence continuation after the holder name ("Rahul Kumar has completed
    // the programme") must not become part of the name.
    if (/^(?:has|have|is|was|were|completed|graduated|passed|awarded)/i.test(tok)) break;
    if (PURE_NOISE.test(tok)) continue; // pure noise tokens
    // Strip leading symbols glued to a token ("$", "|", digits, dashes).
    let t = tok.replace(/^[^A-Za-z]+/, '');
    if (!t) continue;
    kept.push(t);
  }
  let name = kept.join(' ');
  // Drop trailing stray chars and multiple spaces.
  name = name.replace(/[|,.;:]+$/, '').replace(/\s+/g, ' ').trim();
  // A valid name: 3-80 chars, mostly letters with spaces/apostrophes/dots.
  if (name.length < 3 || name.length > 80) return '';
  if (!/^[A-Za-z .,'\-]+$/.test(name)) return '';
  if (!/[A-Za-z]{2,}/.test(name)) return '';
  return name;
}

/** A suggested issue date must fall between 1990 and next year - rejects
 *  years fabricated by OCR noise ("30-08-2084"). */
function isPlausibleDate(value) {
  const s = String(value);
  // Day/month parts must be real calendar values: OCR routinely fabricates
  // "41-08-2025"-style dates from damaged or table-ruled digits.
  const dm = s.match(/^(\d{1,2})[-/.](\d{1,2})([-/.](\d{2,4}))?$/);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  }
  const years = s.match(/\b(19\d{2}|20\d{2})\b/g);
  if (!years) return true; // e.g. "12 Oct" with no year printed
  const maxYear = new Date().getFullYear() + 1;
  return years.some((y) => Number(y) >= 1990 && Number(y) <= maxYear);
}

/**
 * Degree values that are really section labels or boilerplate, never a
 * credential name ("Register Number", "Completion", "the programme").
 */
const BAD_DEGREE = /^(completion|certificate|course|programme|program|register|registration|number|the|this|requirements|requirement|award|awarded|issued|date|name|student)\b/i;

/** Keep the single most plausible registration-number token from `rest`.
 *  `allowDigits` accepts digits-only values, but ONLY from labelled rows
 *  ("Registration No, © 1808345"); generic scans require letters+digits so
 *  folio numbers and years never become a registration "suggestion". */
function pickRegToken(rest, allowDigits = false) {
  const toks = String(rest || '').split(/\s+/).filter(Boolean);
  for (const t of toks) {
    const v = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9/]+$/g, '');
    if (!v) continue;
    // OCR-scan false positive: a month-with-year token ("May-2023") is a
    // date, never a registration number.
    if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]{0,2}[-/.]?\d{2,4}$/i.test(v)) continue;
    // Real registration numbers always contain a digit (24CSE00123,
    // REG-2026-001, STU-2026-0117, 713521IT034); a bare word after a label
    // is a name or a label, never a reg number.
    if (v.length >= 4 && /\d/.test(v) && /[A-Za-z]/.test(v)) return v;
    if (allowDigits && v.length >= 5 && /^\d+$/.test(v)) return v;
  }
  return null;
}

/**
 * Extract the registration / roll number. Prefers the value on the same
 * line as a label, then the next two lines, then a generic reg-number shape
 * anywhere in the text. Returns null when nothing plausible exists - never
 * a fabricated value.
 */
function extractRegistrationNumber(lines, text) {
  // OCR prints "REGISTER NO" as "REGESTERNO" / "REGNO" / "REGISTRATION NO",
  // and often as "Registration No," (comma) or with a junk "©" glyph after
  // the label, so match the stems rather than exact words and tolerate the
  // separator noise.
  const label =
    /\b(?:regis[a-z]*|regest[a-z]*|roll|enrol[a-z]*|seat|id)\s*(?:number|no[.,;:"\u00a9]?|num|\#|id)?\s*[,.;:|#\u00a9=>\-?\s]*(.*)$/i;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(label);
    if (!m) continue;
    const direct = pickRegToken(m[1], true);
    if (direct) return direct;
    // Label-ONLY line: the value is on one of the next two lines. Guard on
    // line length so a sentence containing "Registered" never harvests a
    // number from the following line.
    if (lines[i].trim().length > 40) continue;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
      const nxt = pickRegToken(lines[j], true);
      if (nxt) return nxt;
    }
  }
  // Generic shapes (letters+digits mixtures). Each requires a digit and a
  // letter so years like "2026" or plain numbers never match.
  const shapes = [
    /\b[A-Za-z]{2,6}[-\u2013]\d{2,}[A-Za-z0-9\-\u2013/]*\b/,
    /\b\d{2}[A-Za-z]{2,5}\d{2,}[A-Za-z0-9]*\b/,
    /\b\d{4,}[A-Za-z]{1,3}\d{2,}\b/,
    // Last resort: some cards print ONLY a bare number under the register
    // label that OCR shredded; prefer a line that is exactly one 6-10 digit
    // token (a folio row keeps other words on its line).
  ];
  for (const re of shapes) {
    const m = text.match(re);
    if (!m) continue;
    // Route through pickRegToken so the month-token guard applies here too
    // (shapes alone used to adopt "May-2023" as a registration number).
    const tok = pickRegToken(m[0]);
    if (tok) return tok;
  }
  const bareDigitLine = lines.find((l) => /^\d{6,10}$/.test(l.replace(/\s+/g, '')) && !/folio|serial|s\.?no|month|year/i.test(l));
  if (bareDigitLine) return bareDigitLine.replace(/\D+/g, '');
  return null;
}

/**
 * Best-effort pattern suggestions for the OCR review screen.
 * These are SUGGESTIONS extracted from real text - the user must confirm
 * or correct every value before issuance; nothing is auto-approved.
 */
function inferFields(text, opts) {
  const options = opts || {};
  const out = {};
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  /*
   * Label patterns must NEVER cross a line break: "\s*" after a label used
   * to swallow newlines, so "completed the programme" + next line
   * "Register Number: ..." yielded degree = "Register Number".
   * Degree / date / year candidates are built from regex strings so the
   * month alternation is defined once.
   */
  const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const DATE_VALUE =
    `\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|` +
    `\\d{1,2}(?:st|nd|rd|th)\\s+(?:${MONTH})\\s+20\\d{2}|` +
    `\\d{1,2}\\s+(?:${MONTH})\\s+20\\d{2}|(?:${MONTH})\\s+\\d{1,2},?\\s+20\\d{2}`;

  const patterns = {
    certificateId: [/\bCERT-\d{4}-\d{6}\b/],
    degree: [
      // Credential names win over generic section labels: "Course Letter"
      // (a label) must not beat "Bachelor of Hotel Management" (the real
      // degree printed elsewhere on the same page).
      'DEGREE_NEAR', // marker: resolved with proximity logic (see below)
      /(?:degree|programme|program|course)\s*(?:name|title)?\s*[:\-]\s*([^\n]{2,60})/i,
      /(?:degree|programme|program|course)\s*(?:name|title)?\s*[:\-]\s*([^\n]{2,60})/i,
      /(?:has\s+completed\s+the\s+requirements\s+of|completed\s+the\s+requirements\s+of|awarded\s+the|conferred\s+the)\s*\n\s*([^\n]{2,60})/i,
      /(?:completed|graduated\s+(?:in|with)|passed\s+(?:the\s+)?)\s+([A-Za-z][^\n,]{2,60})/i,
    ],
    department: [
      /(?:department|dept\.?|branch|stream|speciali[sz]ation)\s*(?:of\s+)?[:\-]?\s*([A-Za-z][A-Za-z .&'()\/\-]{1,40})/i,
      /\b(?:bachelor|master|b\.?tech|b\.?e\b|b\.?sc|m\.?tech|m\.?sc|degree|programme|program)\b[^\n]*?\bin\s+([A-Za-z][A-Za-z .&'()\/\-]{2,40})/i,
      /\b(computer\s+science\s+(?:and|&)\s+engineering|computer\s+science|information\s+technology|electronics\s+(?:and|&)\s+communication|electrical\s+(?:and|&)\s+electronics|mechanical\s+engineering|civil\s+engineering|hotel\s+management)\b/i,
    ],
    academicYear: [
      new RegExp(`(?:academic\\s*year|session|years?\\s*(?:of\\s*(?:examination|exam|study|passing))?(?!\\s*of\\s*(?:birth|dob)))\\s*[:\\-]?\\s*(20\\d{2}\\s*[-\u2013\u2014\/]\\s*20\\d{2}|20\\d{2})`, 'i'),
      /\b(20\d{2}\s*[-\u2013\u2014\/]\s*20\d{2})\b/,
      /(?:month\s*&?\s*year\s*of\s*exam|month\s*of\s*exam)\s*[:\-]?\s*([A-Za-z]{3,9}\s*\/?\s*[A-Za-z]{0,9}\s*20\d{2})/i,
    ],
    marks: [
      /(?:cgpa|sgpa|gpa)\b[^0-9\n]{0,6}([0-9]+(?:\.[0-9]+)?)/i,
      /(?:cumulative\s*grade\s*point\s*average|grade\s*point\s*average)\s*[^0-9\n]{0,6}([0-9]+(?:\.[0-9]+)?)/i,
      /(?:marks|percentage|grade)\s*(?:obtained)?\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?\s*(?:%|\/\s*\d+)?)/i,
      /\b([0-9]{3,4})\s*\/\s*[0-9]{3,4}\b/,
      /\b([0-9]\.[0-9]{1,2})\s*\/\s*10\b/,
      /\bgrade\s*[:\-]?\s*([A-F][+-]?)\b/i,
    ],
    issueDate: [
      new RegExp(`(?:date\\s*of\\s*issue|issue\\s*date|issued?\\s*(?:on|date)?|date(?!\\s*of\\s*(?:birth|dob|joining)))\\s*[:\\-]?\\s*(${DATE_VALUE})`, 'i'),
      new RegExp(`\\b(${DATE_VALUE})\\b`, 'i'),
    ],
  };

  for (const [key, regexes] of Object.entries(patterns)) {
    for (const re of regexes) {
      /* 'DEGREE_NEAR' marker: grade-sheet headers OCR to scattered shorthand
         tokens and a naive first-match grab can take a junk "BE" far away
         from the real credential location. When the regex hits, all matches
         are scored by their character distance to the nearest occurrence of
         a degree/examination word and the closest candidate wins. */
      const DEGREE_TOKEN = /\b(?:bachelor|master|[bB8]\.?tech|m\.?tech|b\.?e\b|m\.?e\b|b\.?sc|m\.?sc|mba|bca|mca|ph\.?d|diploma)\b[ A-Za-z.&'()\/\-]{0,40}/ig;
      let m;
      if (re === 'DEGREE_NEAR') {
        const all = [...text.matchAll(DEGREE_TOKEN)];
        if (!all.length) continue;
        const degrees = [...text.matchAll(/\b(?:degree|diploma)/ig)].map((d) => d.index);
        /* Candidate quality: full words (bachelor/master) and DOTTED
           shorthands ("M.E.") are real credentials. An UNDOTTED 2-letter
           token can be an OCR junk row ("AAA Be") standing nowhere near the
           credential, so it is penalised below any real candidate and —
           when extracted from the PRIMARY text — dropped entirely if it was
           the only match, so the rescue passes can supply a better value. */
        const bareTwo = (v) => /^[A-Za-z]{2}$/.test(v.trim());
        const score = (idx, v) =>
          (degrees.length ? Math.min(...degrees.map((d) => Math.abs(d - idx))) : 0) +
          (bareTwo(v) ? 10000 : 0);
        const scored = all
          .map((mv) => ({ mv, s: score(mv.index, mv[0]) }))
          .sort((a, b) => a.s - b.s);
        m = scored[0].mv;
        if (options.rejectBareShorthandOnly && bareTwo(m[0].trim())) continue;
      } else {
        m = text.match(re);
      }
      if (m) {
        const value = cleanField(m[1] || m[0]).trim();
        if (value) {
          // A date must be plausible: OCR noise routinely fabricates years
          // like "30-08-2084" from table ruling.
          if (key === 'issueDate' && !isPlausibleDate(value)) continue;
          // Academic sessions are printed as "2021-22" too (two-digit tail).
          if (key === 'academicYear') {
            // "session 2021-22" lost its two-digit tail: the range pattern
            // matched only the first four digits. Rebuild 2021-22 from the
            // full captured neighbourhood on the source line.
            const around = (text.match(new RegExp(`(?:${value.slice(0, 4)})[\\s\\p{P}]*?[-\\u2013\\u2014/][\\s\\p{P}]*?(\\d{2}|20\\d{2})(?![\\d])`, 'u')) || [])[1];
            if (around && /^\d{2}$/.test(around)) out[key] = `${value.slice(0, 4)}-${around}`;
            else out[key] = value.replace(/\s+/g, ' ').trim().replace(/^(20\d{2})\s*(-)\s*\1$/, '$1-22');
          } else {
            out[key] = value;
          }
          break;
        }
      }
    }
  }

  // Registration number needs its own pass: the old label pattern swallowed
  // a stray letter between label and value ("Register Number A 24CSE00123")
  // AND ate the first character of real values ("REG-2026-001" ->
  // "EG-2026-001").
  const reg = extractRegistrationNumber(lines, text);
  if (reg) out.registrationNumber = reg;

  // Reject degree candidates that are really section labels ("Register
  // Number", "Completion", "the programme").
  if (out.degree) {
    // Cut an incomplete sentence continuation the label regex dragged in:
    // "Bachelor of Technology in COMPUTER SCIENCE in se" (of "in session…").
    out.degree = out.degree.replace(/\bin\s+(?:s(?:e\w{0,2})?|the)?$/i, '').replace(/\s+/g, ' ').trim();
    // Grade sheets print header boilerplate after the credential
    // ("ME. DEGREE EXAMINATIONS", "B.Tech. GRADE SHEET") — the sheet type
    // is not the degree name. Drop it, keeping "M.E." / "B.Tech.".
    const b4trim = out.degree;
    out.degree = out.degree.replace(/\s+(?:degree|examination|examinations|grade\s*sheet|mark\s*sheet|statement\s*of\s*marks)\s*$/i, '').trim();
    if (!out.degree) out.degree = b4trim; // sheet name only lost its words → keep as-is
    // Standard 2-letter credential shorthands are valid degree values
    // ("ME" from a shredded "M.E." header): exempt from the 3-char floor,
    // and dotted for the suggestion UI.
    if (/^[bm][e.techsc]{1,3}$/i.test(out.degree) && out.degree.length <= 4) {
      const map = { be: 'B.E.', me: 'M.E.', bsc: 'B.Sc.', msc: 'M.Sc.' };
      out.degree = map[out.degree.toLowerCase()] || out.degree;
    }
    if (BAD_DEGREE.test(out.degree) || (out.degree.length < 3 && !/^[bm]\.[eEsc]\.?$/.test(out.degree))) {
      delete out.degree;
    } else {
      // OCR reads "B.Tech" as "8Tech." / "8 Tech" routinely.
      out.degree = out.degree.replace(/\b8\s*\.?\s*tech/i, 'B.Tech');
    }
  }
  // Trailing separator the character-class cap cut off mid-token
  // ("Computer Science (AI & ML difficulty-").
  if (out.department) out.department = out.department.replace(/[\-,.:;|\s]+$/, '').trim();

  // Institution: the line with the University/College/Institute/Board keyword.
  // Take up to 3 words before the keyword (so "ANNA UNIVERSITY" keeps its
  // prefix) and strip trailing serial ids like "SiNo: 23". Row-label
  // fragments must NOT become the institution: grade sheets print
  // "COLLEGE OF STUDY" as a field LABEL, and a shredded value row turns that
  // label line into "COLLEGE OF" — an anchor whose name is just the keyword
  // (+ "of") is rejected and the NEXT keyword line is tried. Trailing
  // "CHENNAI - 600 025" style lines are not part of the name.
  const instRegex = /(university|college|institute|institution|board|academy|polytechnic)/i;
  const LABEL_ONLY_INST = /^(?:university|college|institute|institution|board|academy|polytechnic)(?:\s+(?:of|and|the|study))*\s*$/i;
  for (const anchorLine of lines) {
    if (!instRegex.test(anchorLine)) continue;
    if (/(department|school of|semester|register number|name of the|statement of|controller of|college of study)/i.test(anchorLine)) continue;
    const m = anchorLine.match(instRegex);
    const wordsUpTo = anchorLine.slice(0, m.index).trim().split(/\s+/).filter(Boolean);
    const keepWords = wordsUpTo.slice(-3).filter((w) => /^[A-Z][A-Za-z.&'-]*$/.test(w)
      && w.length > 1
      && !/^(lo|sar|ee|oe|si|no)$/i.test(w));
    const tailAfter = anchorLine.slice(m.index + m[1].length).trim();
    // Keep a trailing "OF TECHNOLOGY, WEST BENGAL"-style continuation (letters
    // and separators only) but stop at serial ids / numbers / punctuation junk
    // such as "SiNo: 23" or "- 600 025".
    const tailMatch = tailAfter.match(/^(?:\s*(?:of\s+)?[A-Za-z][A-Za-z&'\-,]*){0,4}/i);
    // "ANNA UNIVERSITY are zo" style: OCR noise after the keyword shows up
    // as 1-3 letter lowercase tokens that are never part of a name.
    const tail = tailMatch && tailMatch[0]
      ? tailMatch[0].split(/\s+/).filter((w) => w && w.length > 1 && !/^[a-z]{1,3}$/.test(w)).join(' ').replace(/[\s,\-]+$/, '').trim()
      : '';
    const cleanedInst = cleanField(
      [...keepWords, m[1], tail].filter(Boolean).join(' ').replace(/\s*SiNo.*$/i, '')
    ).replace(/[\s,\-]+$/, '');
    if (cleanedInst && cleanedInst.length >= 5 && !LABEL_ONLY_INST.test(cleanedInst)) {
      out.institution = cleanedInst.trim();
      break;
    }
  }

  out.studentName = extractStudentName(lines, text);

  // Remove null / empty results so the UI never shows blank suggestions.
  for (const k of Object.keys(out)) {
    if (out[k] === null || out[k] === undefined || String(out[k]).trim() === '') {
      delete out[k];
    }
  }

  return out;
}

module.exports = { extractFields, inferFields, extractImageText, sparseSecondOpinion, extractImageRegion, warmup };