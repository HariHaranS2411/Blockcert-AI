'use strict';

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

/**
 * Real OCR / text extraction from the uploaded document.
 * PDFs are parsed with pdf-parse; images are run through Tesseract.js.
 * Never invents values: when insufficient text is found it reports so.
 */

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

async function extractImageText(filePath) {
  let worker;
  try {
    worker = await getWorker();
    const { data } = await worker.recognize(filePath);
    return (data && data.text ? data.text : '').trim();
  } catch (err) {
    // The worker's WASM state may be poisoned after an abort - drop it so
    // the next request starts clean instead of failing forever.
    discardWorker();
    if (worker && typeof worker.terminate === 'function') {
      try { await worker.terminate(); } catch (_) { /* already dead */ }
    }
    throw err;
  }
}

async function extractPdfText(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const pdf = await pdfParse(buffer);
  return (pdf && pdf.text ? pdf.text : '').trim();
}

/**
 * Extract raw text plus best-effort field suggestions from a real document.
 * Returns { status: 'completed' | 'insufficient' | 'failed', text, fields, error }
 */
async function extractFields(filePath, mimetype) {
  const fields = {};
  let text = '';
  try {
    if (mimetype === 'application/pdf') {
      text = await extractPdfText(filePath);
    } else {
      text = await extractImageText(filePath);
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

  Object.assign(fields, inferFields(cleaned));
  return { status: 'completed', text: cleaned, fields, error: null };
}

/* OCR noise commonly printed around label/table cells: pipes, brackets,
   dashes, colons, stray symbols. Pure digit tokens like "2024" are NOT
   noise by themselves - exam years and marks are valid values. */
const PURE_NOISE = /^[|$#+=~^`_*·•—\-.,\s]+$/;

/** Tokens that almost always mark the END of a name/value in a table row
    layout, e.g. "HARI HARAN Semester 4 | Degree ...". */
const VALUE_TERMINATORS = /^(semester|term|regulation|result|month|date|session|degree|branch|speciali[sz]ation|register|roll|enrol|enroll|dob|contact|place|issued|signature|controller|status|exam|examination|centre|center|marks|grade|subject|title|credits|internal|external|total|sl\.?no)/i;

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
  const labelRegex = /(?:name\s*of\s*(?:the\s*)?(?:student|candidate|recipient)|(?:student|candidate|applicant)\s*name|^\s*name\b)\s*[:\-]?\s*(.*)$/i;

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
    if (/^(?:name\s*of\s*(?:the\s*)?(?:student|candidate|recipient)|(?:student|candidate)\s*name|name)\b\s*[:\-]?\s*$/i.test(lines[i])) {
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

  const tokens = s.split(/\s+/);
  const kept = [];
  for (const tok of tokens) {
    if (VALUE_TERMINATORS.test(tok)) break;
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

/**
 * Best-effort pattern suggestions for the OCR review screen.
 * These are SUGGESTIONS extracted from real text - the user must confirm
 * or correct every value before issuance; nothing is auto-approved.
 */
function inferFields(text) {
  const out = {};
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const patterns = {
    registrationNumber: [
      /register(?:ation)?\s*(?:number|no\.?|#)?\s*[:\-]?\s*(?:[A-Za-z]\s*)?([A-Za-z0-9][A-Za-z0-9/\-]{2,39})/i,
      /roll\s*(?:number|no\.?)?\s*[:\-]?\s*(?:[A-Za-z]\s*)?([A-Za-z0-9][A-Za-z0-9/\-]{2,39})/i,
      /(?:reg\.?|roll)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9/\-]{2,39})/i,
    ],
    certificateId: [/\bCERT-\d{4}-\d{6}\b/],
    degree: [
      /\bdegree\b[^A-Za-z]{0,10}([A-Za-z][A-Za-z .&'()\/\-]{1,40})/i,
      /(?:programme|program|course)\s*(?:name)?\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 .&'()\/\-]{2,60})/i,
      /\b(?:bachelor|master|b\.?tech|m\.?tech|b\.?e\b|m\.?e\b|b\.?sc|m\.?sc|mba|bca|mca|ph\.?d)\b[ A-Za-z.]{0,40}/i,
    ],
    department: [
      /speciali[sz]ation\s*[^A-Za-z]{0,10}([A-Za-z][A-Za-z .&'-]{3,60})/i,
      /(?:department|dept)\.?\s*(?:of)?\s*[:\-]?\s*([A-Za-z][A-Za-z .&'-]{3,60})/i,
      /\bbranch\b[^A-Za-z]{0,10}([A-Za-z][A-Za-z .&'-]{3,60})/i,
    ],
    academicYear: [/(?:academic\s*year|session|year)\s*[:\-]?\s*((?:20\d{2}\s*[-/]\s*20\d{2})|(?:20\d{2}))/i,
                   /(?:month\s*&?\s*year\s*of\s*exam|month\s*of\s*exam)\s*[:\-]?\s*([A-Za-z]{3,9}\s*\/?\s*[A-Za-z]{0,9}\s*20\d{2})/i],
    marks: [/(?:cgpa|gpa)\b[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)/i,
            /(?:cumulative\s*grade\s*point\s*average|grade\s*point\s*average)\s*[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)/i,
            /(?:marks|percentage|grade)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?\s*(?:%|\/\s*10)?)/i],
    issueDate: [
      /(?:date\s*of\s*issue|issued\s*on|issue\s*date)\s*[:\-]?\s*((?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4})|(?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2}))/i,
    ],
  };

  for (const [key, regexes] of Object.entries(patterns)) {
    for (const re of regexes) {
      const m = text.match(re);
      if (m) {
        const value = cleanField(m[1] || m[0]).trim();
        if (value) {
          out[key] = value;
          break;
        }
      }
    }
  }

  // Registration number: OCR often prints a stray single letter between the
  // label and the real number ("Register Number A 24CSE00123"). Also accept
  // the first token matching a plausibe reg-number shape.
  if (out.registrationNumber) {
    const tok = String(out.registrationNumber).replace(/^[^A-Za-z0-9]+|[^\w/\-]+$/g, '');
    // Remove this single stray letter prefix when a longer token follows.
    const m2 = String(out.registrationNumber).match(/^(?:[A-Za-z]\s+)?([A-Za-z0-9][\w/\-]+)$/);
    out.registrationNumber = m2 ? m2[1] : tok;
  }

  // Institution: the line with the University/College/Institute/Board keyword.
  // Take up to 2 words before the keyword (so "ANNA UNIVERSITY" keeps its
  // prefix) and strip trailing serial ids like "SiNo: 23". Trailing
  // "CHENNAI - 600 025" style lines are not part of the name.
  const instRegex = /(university|college|institute|institution|board|academy|polytechnic)/i;
  const anchorLine = lines.find((l) =>
    instRegex.test(l) &&
    !/(department|school of|semester|register number|name of the|statement of|controller of)/i.test(l)
  );
  if (anchorLine) {
    const m = anchorLine.match(instRegex);
    const wordsUpTo = anchorLine.slice(0, m.index).trim().split(/\s+/).filter(Boolean);
    const keepWords = wordsUpTo.slice(-3).filter((w) => /^[A-Z][A-Za-z.&'-]*$/.test(w)
      && !/^(lo|sar|ee|oe|si|no)$/i.test(w));
    const tailAfter = anchorLine.slice(m.index + m[1].length).trim();
    // Keep a trailing "OF TECHNOLOGY"-style continuation (letters only) but
    // stop at serial ids / numbers / punctuation junk such as "SiNo: 23".
    const tailMatch = tailAfter.match(/^(?:\s+(?:of\s+)?[A-Za-z][A-Za-z&'\-]*){0,3}/i);
    const tail = tailMatch && tailMatch[0] ? tailMatch[0].trim() : '';
    const cleanedInst = cleanField(
      [...keepWords, m[1], tail].filter(Boolean).join(' ').replace(/\s*SiNo.*$/i, '')
    );
    if (cleanedInst && cleanedInst.length >= 4) {
      out.institution = cleanedInst.trim();
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

module.exports = { extractFields, inferFields };