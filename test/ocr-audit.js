'use strict';
/**
 * test/ocr-audit.js — accuracy report for OCR field extraction.
 *
 * For every issued certificate we run the real OCR pipeline over its stored
 * document and compare `inferFields()` suggestions against the values the
 * institution actually issued (ground truth in the certificates table).
 *
 * Usage: node test/ocr-audit.js [certificateId ...]
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { initDatabase, query } = require('../config/database');
const ocrService = require('../services/ocrService');

const norm = (v) =>
  String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Canonical token list: expands degree abbreviations and drops glue words
 *  so "B.Tech Computer Science" and "Bachelor of Technology in Computer
 *  Science" compare equal. */
function tokens(v) {
  let s = norm(v);
  s = s
    .replace(/\bb\s+e\b/g, ' be ')
    .replace(/\bm\s+e\b/g, ' me ')
    .replace(/bachelor\s+of\s+technology|b\s?tech/g, ' btech ')
    .replace(/bachelor\s+of\s+engineering|b\s?e\s/g, ' be ')
    .replace(/bachelor\s+of\s+science|b\s?sc/g, ' bsc ')
    .replace(/master\s+of\s+technology|m\s?tech/g, ' mtech ')
    .replace(/master\s+of\s+science|m\s?sc/g, ' msc ')
    .replace(/\b(of|and|in|the|a|an)\b/g, ' ');
  return s.split(' ').filter(Boolean);
}

/** Extract comparable (month, day[, year]) parts; month is 1-12 or a name. */
function dateParts(v) {
  const s = String(v == null ? '' : v);
  const iso = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const monthNames = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const named = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i);
  if (named) return { m: monthNames[named[1].toLowerCase().slice(0, 3)], d: Number(named[2]) };
  const dayFirst = s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (dayFirst) return { d: Number(dayFirst[1]), m: Number(dayFirst[2]) };
  return null;
}

function same(truth, got, docText) {
  if (!truth) return 'noTruth'; // no ground truth to compare
  const t = norm(truth);
  if (t.length < 2) return 'noTruth'; // junk single-char truth (e.g. "1")

  const doc = norm(docText);

  // Branch abbreviations: the document says "Computer Science and
  // Engineering", the record says "CSE" — both are correct.
  const BRANCHES = [
    [/computer\s*science\s*(and|&)\s*engineering|computer\s*science/, 'cse'],
    [/electronics\s*(and|&)\s*communication/, 'ece'],
    [/electrical\s*(and|&)\s*electronics/, 'eee'],
    [/information\s*technology/, 'it'],
    [/mechanical/, 'mech'],
    [/civil/, 'civil'],
  ];
  const canonBranch = (v) => {
    let s = norm(v);
    for (const [re, abbr] of BRANCHES) if (re.test(s)) s += ' ' + abbr;
    return s;
  };

  // Dates: if the document contains no date at all, the date is
  // unextractable rather than an extraction bug.
  const tp = dateParts(truth);
  if (tp) {
    const gp = got ? dateParts(got) : null;
    if (gp && tp.m === gp.m && (tp.d === gp.d || tp.d == null || gp.d == null)) return 'hit';
    // Only a real miss when the document actually PRINTS this date.
    const dateRe = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi;
    const printed = (String(docText).match(dateRe) || [])
      .map(dateParts)
      .some((d) => d && d.m === tp.m && (d.d == null || tp.d == null || d.d === tp.d));
    return printed ? 'miss' : 'absent';
  }

  const truthToks = tokens(canonBranch(truth));
  const relevant = truthToks.filter((w) => w.length >= 3 || /\d/.test(w));
  const present = relevant.filter((w) => doc.includes(w));
  const inDoc = doc.includes(norm(canonBranch(truth))) ||
    (relevant.length > 0 && present.length / relevant.length >= 0.6);
  if (!inDoc) return 'absent';

  const g = norm(got);
  if (!g) return 'miss';
  if (norm(canonBranch(truth)) === g) return 'hit';

  const gt = tokens(canonBranch(got));
  const hitT = truthToks.filter((w) => gt.includes(w)).length;
  const hitG = gt.filter((w) => truthToks.includes(w)).length;
  if (truthToks.length && hitT / truthToks.length >= 0.6) return 'hit';
  if (gt.length && hitG / gt.length >= 0.6) return 'hit';
  return 'miss';
}

async function main() {
  initDatabase();
  const only = process.argv.slice(2);
  const where = only.length ? `WHERE certificate_id IN (${only.map((_, i) => `$${i + 1}`).join(',')})` : '';
  const res = await query(
    `SELECT certificate_id, document_path, document_mime, student_name, registration_number,
            degree, department, academic_year, marks, issue_date, institution_id
       FROM certificates ${where} ORDER BY id`,
    only
  );

  const instRes = await query('SELECT id, name FROM institutions');
  const instById = Object.fromEntries(instRes.rows.map((r) => [r.id, r.name]));

  const fields = ['studentName', 'registrationNumber', 'degree', 'department', 'academicYear', 'marks', 'issueDate'];
  const tally = Object.fromEntries(fields.map((f) => [f, { hit: 0, miss: 0, absent: 0, noTruth: 0, missList: [] }]));
  let docs = 0;
  let unreadable = 0;

  for (const row of res.rows) {
    const file = path.join(__dirname, '..', 'uploads', row.document_path);
    if (!row.document_path || !fs.existsSync(file)) {
      console.log(`\n--- ${row.certificate_id}: document missing on disk (${row.document_path})`);
      continue;
    }
    docs += 1;
    const out = await ocrService.extractFields(file, row.document_mime || 'application/pdf');
    if (out.status !== 'completed') {
      unreadable += 1;
      console.log(`\n--- ${row.certificate_id}: OCR ${out.status} (${out.error})`);
      continue;
    }
    const f = out.fields || {};
    const truth = {
      studentName: row.student_name,
      registrationNumber: row.registration_number,
      degree: row.degree,
      department: row.department,
      academicYear: row.academic_year,
      marks: row.marks,
      issueDate: row.issue_date ? String(row.issue_date).slice(0, 10) : null,
    };
    console.log(`\n--- ${row.certificate_id} (${row.document_mime}) text=${out.text.length} chars`);
    const problems = [];
    for (const key of fields) {
      const cmp = same(truth[key], f[key], out.text);
      if (cmp === 'noTruth') {
        tally[key].noTruth += 1;
        continue;
      }
      if (cmp === 'absent') {
        tally[key].absent += 1;
        continue;
      }
      if (cmp === 'hit') tally[key].hit += 1;
      else {
        tally[key].miss += 1;
        tally[key].missList.push(row.certificate_id);
        problems.push(`${key}: got=${JSON.stringify(f[key] || null)} want=${JSON.stringify(truth[key])}`);
      }
    }
    const instCmp = same(instById[row.institution_id], f.institution, out.text);
    if (instCmp === 'miss') {
      problems.push(`institution: got=${JSON.stringify(f.institution || null)} want=${JSON.stringify(instById[row.institution_id])}`);
    }
    problems.forEach((p) => console.log('   ✗ ' + p));
    if (problems.length === 0) console.log('   ✓ all fields matched');
    if (process.env.SHOW_TEXT) console.log('   TEXT:\n' + out.text.split('\n').map((l) => '     | ' + l).join('\n'));
  }

  console.log('\n========== SUMMARY ==========');
  console.log(`documents scanned: ${docs}  unreadable: ${unreadable}`);
  for (const key of fields) {
    const t = tally[key];
    const total = t.hit + t.miss;
    console.log(
      `${key.padEnd(22)} ${String(t.hit).padStart(2)}/${String(total).padEnd(2)} hit` +
        (t.absent ? `  (not in document: ${t.absent})` : '') +
        (t.noTruth ? `  (no truth: ${t.noTruth})` : '') +
        (t.miss ? `  missed: ${t.missList.join(', ')}` : '')
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
