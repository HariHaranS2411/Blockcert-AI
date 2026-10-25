'use strict';

/**
 * Duplicate / copy detection: does an uploaded document reproduce a
 * certificate that is ALREADY registered on this platform?
 *
 * This is a deterministic PLATFORM check, never an AI judgment: a copy of an
 * issued certificate is textually (often byte-for-byte) identical to the
 * original, so the text-only fraud model cannot see the difference and must
 * not be asked to. Two detection levels:
 *
 *  - 'byte-exact': SHA-256 of the uploaded file equals the document_hash of a
 *    registered certificate. The copy IS the official document.
 *  - 'content-match': different bytes (re-scan / screenshot / recompression)
 *    but the same document. Stored ocr_text can be stale (extracted by older
 *    OCR pipelines), so candidates are narrowed by IDENTITY signals against
 *    the official record (registration number / student name agreement) and
 *    confirmed by FRESH re-extraction of the candidate's stored document.
 *    A confirmed fresh extraction also self-heals the stale ocr_text cache.
 *
 * When a matched copy's extracted fields disagree with the official record,
 * those differences are reported in the Duplicate status check (a warning row
 * naming exactly which fields differ). They are deliberately NOT passed to
 * the AI as tampering evidence: on this platform record-vs-print mismatches
 * are issuance-era typing artifacts (PRADI/"be"/"7.5" class DB errors), and
 * feeding them to the model false-alarms legitimate copies at ~95 Tampered.
 * evidenceForModel() is retained for the documented experiment only.
 */

const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const hashService = require('./hashService');
const ocrService = require('./ocrService');

/* ------------------------------------------------------------------ */
/* Normalization + lenient value comparison (mirrors the OCR audit)    */
/* ------------------------------------------------------------------ */

const norm = (v) =>
  String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STOP = new Set(['of', 'and', 'in', 'the', 'a', 'an']);

function tokens(v) {
  const s = norm(v)
    .replace(/bachelor\s+of\s+technology|b\s?tech/g, 'btech')
    .replace(/bachelor\s+of\s+engineering|b\s?e\b/g, 'be')
    .replace(/bachelor\s+of\s+science|b\s?sc/g, 'bsc')
    .replace(/master\s+of\s+technology|m\s?tech/g, 'mtech')
    .replace(/master\s+of\s+science|m\s?sc/g, 'msc');
  return s.split(' ').filter((w) => w && !STOP.has(w));
}

/** OCR drops/merges letters ("PRADI" vs "PRADIP"); containment counts as
 *  agreement, while different values ("7.5" vs "4.48") do not. */
function valuesAgree(printed, official) {
  const t = norm(official);
  const g = norm(printed);
  if (!t) return null; // no official value recorded -> cannot judge
  if (!g) return null;
  if (t === g) return true;
  if (t.includes(g) || g.includes(t)) return true;
  const tt = tokens(official);
  const gt = tokens(printed);
  if (!tt.length || !gt.length) return null;
  return gt.filter((w) => tt.includes(w)).length / tt.length >= 0.6;
}

/** Month/day-only date agreement; full string formats often differ. */
function datesAgree(printed, official) {
  if (official == null || official === '') return null;
  const part = (v) => {
    const s = String(v == null ? '' : v);
    const iso = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const named = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i);
    if (named) return { m: months[named[1].toLowerCase().slice(0, 3)], d: +named[2] };
    const dayFirst = s.match(/(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?/);
    if (dayFirst) return { m: +dayFirst[2], d: +dayFirst[1] };
    return null;
  };
  const op = part(official);
  const pp = printed ? part(printed) : null;
  if (!op) return null;
  if (!pp) return null; // not printed on this copy -> cannot judge
  return op.m === pp.m && (op.d == null || pp.d == null || op.d === pp.d);
}

function tokenSet(text) {
  return new Set(tokens(String(text || '')));
}

function overlap(a, b) {
  const min = Math.min(a.size, b.size);
  if (!min) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / min;
}

/** True when at least ONE primary identity field is present in both and
 *  agrees. Template-identical sheets of a DIFFERENT holder must not match. */
function identityAgrees(fields, row, extraFields1, extraFields2) {
  const sources = [fields, extraFields1, extraFields2].filter(Boolean);
  for (const src of sources) {
    const reg = valuesAgree(src.registrationNumber, row.registration_number);
    if (reg === true) return true;
    const name = valuesAgree(src.studentName, row.student_name);
    if (name === true) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Reference + difference building                                    */
/* ------------------------------------------------------------------ */

function isoDate(v) {
  if (!v) return null;
  try {
    return new Date(v).toISOString().slice(0, 10);
  } catch (_) {
    return String(v).slice(0, 10);
  }
}

function refOf(row) {
  return {
    certificateId: row.certificate_id,
    status: row.status,
    issueDate: row.issue_date ? isoDate(row.issue_date) : null,
    registeredAt: row.created_at ? isoDate(row.created_at) : null,
    studentName: row.student_name || null,
    institution: row.institution_name || null,
    registrationNumber: row.registration_number || null,
    degree: row.degree || null,
    department: row.department || null,
    marks: row.marks === null || row.marks === undefined ? null : String(row.marks),
  };
}

/**
 * Extracted fields that DISAGREE with the official record (only for values
 * actually printed on the copy; an unreadable field is never flagged, and a
 * value with no official counterpart can never disagree).
 */
function fieldDifferences(fields, row) {
  const out = [];
  const checks = [
    ['studentName', 'name', row.student_name],
    ['registrationNumber', 'registration number', row.registration_number],
    ['degree', 'degree', row.degree],
    ['department', 'department', row.department],
    ['marks', 'marks', row.marks],
  ];
  for (const [key, label, official] of checks) {
    if (official == null || official === '') continue;
    const printed = fields ? fields[key] : null;
    if (!printed) continue;
    const agree = valuesAgree(printed, official);
    if (agree === false) out.push({ field: label, printed: String(printed), official: String(official) });
  }
  const printedDate = fields ? fields.issueDate : null;
  if (printedDate) {
    const agree = row.issue_date ? datesAgree(printedDate, row.issue_date) : null;
    if (agree === false) out.push({ field: 'issue date', printed: String(printedDate), official: isoDate(row.issue_date) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Detection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Main entry. Always resolves to:
 * {
 *   level: 'byte-exact' | 'content-match' | null,
 *   reference: { certificateId, status, issueDate, studentName, ... } | null,
 *   differences: [{ field, printed, official }],
 * }
 */
async function detectDuplicate({ filePath, mimetype, text, fields, certificateId } = {}) {
  const result = { level: null, reference: null, differences: [] };
  if (!filePath) return result;

  let hash = null;
  try {
    hash = await hashService.hashFile(filePath);
  } catch (_) {
    hash = null;
  }

  if (hash) {
    const exact = await query(
      `SELECT c.certificate_id, c.status, c.issue_date, c.created_at, c.student_name,
              c.registration_number, c.degree, c.department, c.marks,
              i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.document_hash = $1
        LIMIT 1`,
      [hash]
    );
    if (exact.rows.length) {
      result.level = 'byte-exact';
      result.reference = refOf(exact.rows[0]);
      return result; // identical bytes -> identical content by definition
    }
  }

  const upToks = tokenSet(text);
  if (upToks.size < 8) return result;

  // Candidate narrowing on IDENTITY signals from the official record. The
  // stored ocr_text is often stale, so raw-text similarity alone is not a
  // reliable screen - but an agreeing registration number or student name is.
  const rows = await query(
    `SELECT c.id, c.certificate_id, c.status, c.issue_date, c.created_at, c.ocr_text,
            c.document_path, c.document_mime, c.student_name, c.registration_number,
            c.degree, c.department, c.marks,
            i.name AS institution_name
       FROM certificates c JOIN institutions i ON i.id = c.institution_id
      WHERE c.document_path IS NOT NULL`
  );

  const candidates = rows.rows.filter((row) => {
    if (row.ocr_text && overlap(upToks, tokenSet(row.ocr_text)) >= 0.6) return true;
    return identityAgrees(fields, row);
  });

  // Confirm against a FRESH extraction of the candidate document (bounded:
  // at most 3 tesseract passes per request).
  for (const row of candidates.slice(0, 3).sort((a, b) => overlap(upToks, tokenSet(a.ocr_text)) - overlap(upToks, tokenSet(b.ocr_text)))) {
    const file = path.join('uploads', row.document_path);
    if (!fs.existsSync(file)) continue;
    let fresh;
    try {
      fresh = await ocrService.extractFields(file, row.document_mime || 'application/pdf');
    } catch (_) {
      continue;
    }
    if (fresh.status !== 'completed' || !fresh.text || fresh.text.split(/\s+/).filter(Boolean).length < 8) continue;
    // Self-heal the stale cache: keep the fresh extraction when it is at
    // least as informative as what is stored. ocr_text is an internal cache
    // (audit + duplicate detection), never a user-facing field.
    if (!row.ocr_text || fresh.text.length >= String(row.ocr_text).length) {
      await query('UPDATE certificates SET ocr_text = $1 WHERE id = $2 AND (ocr_text IS NULL OR LENGTH($1) >= LENGTH(ocr_text))', [fresh.text, row.id]).catch(() => {});
    }
    const score = overlap(upToks, tokenSet(fresh.text));
    // Strong: near-identical text (byte-different PNG copies OCR
    // deterministically). Loose + identity: aggressive recompression (JPEG)
    // genuinely degrades OCR, so instead require the SAME printed values to
    // be extracted from both documents - same pixels produce the same
    // fields, template-identical sheets of another holder do not.
    const sameFields = identityAgrees(fields, { student_name: fresh.fields ? fresh.fields.studentName : null, registration_number: fresh.fields ? fresh.fields.registrationNumber : null }, fresh.fields);
    if (score >= 0.75 || (score >= 0.35 && sameFields)) {
      result.level = 'content-match';
      result.reference = refOf(row);
      result.differences = fieldDifferences(fields, row);
      return result;
    }
  }

  // The analysis was explicitly requested FOR a certificate: that record's
  // stored document is a high-value candidate even when the official-record
  // identity fields disagree with the print (issuance-era typing slips), so
  // compare the upload against a fresh extraction of THAT document. The
  // identity gate is waived here - the requester targeted the record - but
  // any content divergence is still reported in the check and differences.
  if (!result.level && certificateId) {
    const targeted = await query(
      `SELECT c.id, c.certificate_id, c.status, c.issue_date, c.created_at, c.ocr_text,
              c.document_path, c.document_mime, c.student_name, c.registration_number,
              c.degree, c.department, c.marks,
              i.name AS institution_name
         FROM certificates c JOIN institutions i ON i.id = c.institution_id
        WHERE c.certificate_id = $1 AND c.document_path IS NOT NULL`,
      [String(certificateId).trim().toUpperCase()]
    );
    const row = targeted.rows[0];
    if (row) {
      const file = path.join('uploads', row.document_path);
      if (fs.existsSync(file)) {
        let fresh = null;
        try {
          fresh = await ocrService.extractFields(file, row.document_mime || 'application/pdf');
        } catch (_) {
          fresh = null;
        }
        if (fresh && fresh.status === 'completed' && fresh.text) {
          if (!row.ocr_text || fresh.text.length >= String(row.ocr_text).length) {
            await query('UPDATE certificates SET ocr_text = $1 WHERE id = $2 AND (ocr_text IS NULL OR LENGTH($1) >= LENGTH(ocr_text))', [fresh.text, row.id]).catch(() => {});
          }
          const score = overlap(upToks, tokenSet(fresh.text));
          const sameFields = identityAgrees(fields, { student_name: fresh.fields ? fresh.fields.studentName : null, registration_number: fresh.fields ? fresh.fields.registrationNumber : null }, fresh.fields);
          if (score >= 0.75 || (score >= 0.35 && sameFields)) {
            result.level = 'content-match';
            result.reference = refOf(row);
            result.differences = fieldDifferences(fields, row);
          }
        }
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Deterministic check + evidence builders                            */
/* ------------------------------------------------------------------ */

/**
 * Build the injected 'Duplicate status' check for the AI result's checks grid.
 * `requestedCertificateId` is the certificate the analysis was run FOR (may
 * be null); when the document actually belongs to a DIFFERENT registered
 * certificate the check becomes a warning.
 */
function buildDuplicateCheck(duplicate, requestedCertificateId) {
  if (!duplicate) return null;
  const reqId = requestedCertificateId ? String(requestedCertificateId).trim().toUpperCase() : null;
  const ref = duplicate.reference;

  if (!ref) {
    return {
      name: 'Duplicate status',
      status: 'insufficient',
      note: 'No certificate already registered on this platform matches this document, so it is assessed as a new document.',
    };
  }

  const refText = `certificate ${ref.certificateId} (${String(ref.status || '').toLowerCase()}${
    ref.issueDate ? ', issued ' + ref.issueDate : ''
  })`;

  if (duplicate.level === 'byte-exact') {
    if (reqId && reqId !== ref.certificateId) {
      return {
        name: 'Duplicate status',
        status: 'warning',
        note: `Byte-identical copy of the official document registered for ${refText} - but this analysis was requested for certificate ${reqId}. The document does not belong to that record.`,
      };
    }
    return {
      name: 'Duplicate status',
      status: 'pass',
      note: `Byte-identical copy of the official document registered for ${refText}; the copy matches the issuer record exactly.`,
    };
  }

  // content-match
  if (!duplicate.differences.length) {
    if (reqId && reqId !== ref.certificateId) {
      return {
        name: 'Duplicate status',
        status: 'warning',
        note: `Content matches the official document registered for ${refText}, but this analysis was requested for certificate ${reqId}.`,
      };
    }
    return {
      name: 'Duplicate status',
      status: 'pass',
      note: `A copy/re-scan of the official document registered for ${refText}: different bytes, identical content.`,
    };
  }

  const listed = duplicate.differences
    .slice(0, 4)
    .map((d) => `${d.field} "${d.printed}" vs official "${d.official}"`)
    .join('; ');
  const more = duplicate.differences.length > 4 ? ` (+${duplicate.differences.length - 4} more)` : '';
  return {
    name: 'Duplicate status',
    status: 'warning',
    note: `Content matches certificate ${ref.certificateId}, but ${duplicate.differences.length} field(s) differ from the official record: ${listed}${more}.`,
  };
}

/**
 * Deterministic VERDICT a duplicate raises the headline assessment to, on
 * top of the model's tamper score. A copy that reproduces the official
 * record exactly (byte-exact, or re-scan with no field differences) is NOT
 * tampered: it keeps the model's authentic-level score, it is just labeled
 * as a verified duplicate. A copy whose printed fields DISAGREE with the
 * official record is genuinely suspect - the record is the issuer's truth -
 * so the headline is deterministically raised into the Suspicious band
 * (independent of what the text/vision model found, which cannot see the
 * record at all) while the model's own classification is kept when already
 * higher (tampered stays tampered).
 */
const SUSPICIOUS_FLOOR = 45;

function applyDuplicateVerdict(result, duplicate, requestedCertificateId) {
  if (!result || !duplicate || !duplicate.reference) return null;

  if (duplicate.level === 'byte-exact' || !duplicate.differences.length) {
    result.duplicateVerdict = {
      verdict: 'verified-duplicate',
      label: 'Verified duplicate of the official record',
      elevatedRisk: false,
    };
    return result.duplicateVerdict;
  }

  const differs = duplicate.differences
    .slice(0, 4)
    .map((d) => `${d.field} "${d.printed}" (official: "${d.official}")`)
    .join('; ');
  result.riskScore = Math.max(result.riskScore, SUSPICIOUS_FLOOR);
  if (result.classification === 'Likely Authentic') {
    result.classification = 'Suspicious';
  }
  result.findings = [
    `COPY DIFFERS FROM OFFICIAL RECORD: this upload reproduces the document registered for certificate ${duplicate.reference.certificateId}, but restores these fields to values that disagree with the official record: ${differs} (+${duplicate.differences.length} total). A copy is judged against the issuer record, and a divergence there is concrete evidence of alteration until the issuer confirms otherwise.`,
    ...result.findings,
  ];
  result.duplicateVerdict = {
    verdict: 'differs-from-record',
    label: 'Copy differs from the official record',
    elevatedRisk: true,
  };
  return result.duplicateVerdict;
}

/**
 * Evidence block for the fraud model - returned ONLY when the duplicate's
 * content disagrees with the official record (otherwise the model sees
 * nothing new: an unaltered copy carries no signal for it to weigh).
 */
function evidenceForModel(duplicate) {
  if (!duplicate || duplicate.level !== 'content-match' || !duplicate.differences.length) return null;
  const ref = duplicate.reference;
  const official = [
    ref.studentName ? `student name "${ref.studentName}"` : null,
    ref.registrationNumber ? `registration number "${ref.registrationNumber}"` : null,
    ref.degree ? `degree "${ref.degree}"` : null,
    ref.department ? `department "${ref.department}"` : null,
    ref.marks ? `marks "${ref.marks}"` : null,
  ].filter(Boolean);
  return [
    `PLATFORM RECORD MATCH: this upload reproduces the document registered for certificate ${ref.certificateId} (status ${String(
      ref.status || ''
    ).toLowerCase()}, issued ${ref.issueDate || 'unknown'}).`,
    `Official record values: ${official.join('; ')}.`,
    'Printed values in THIS upload that disagree with the official record:',
    ...duplicate.differences.map((d) => `- ${d.field}: printed "${d.printed}" vs official "${d.official}"`),
    '',
    'Weighing rule: character-level slips, a missing final letter or case/formatting differences are usually OCR noise or typing errors at issuance and are NOT alterations by themselves. Wholesale replacement of a value (a different name, different marks, a different registration number) IS concrete textual evidence of alteration: quote the replaced values from the official record.',
  ];
}

module.exports = { detectDuplicate, buildDuplicateCheck, evidenceForModel, applyDuplicateVerdict, valuesAgree, fieldDifferences, SUSPICIOUS_FLOOR };
