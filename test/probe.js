'use strict';
/* Live probe of reported issues: OCR, bulk issue, revoke, profile. Real data only. */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const BASE = 'http://127.0.0.1:5000';
const EMAIL = process.argv[2] || 'registrar1791388355567@example.edu';
const PASS = process.argv[3] || 'Passw0rd!x';

async function j(method, p, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function makePdf(file, lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    lines.forEach((l) => doc.text(l + '\n'));
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

(async () => {
  const login = await j('POST', '/api/auth/login', { body: { email: EMAIL, password: PASS } });
  console.log('LOGIN', login.status, login.json && login.json.message);
  const token = login.json && login.json.data && login.json.data.token;
  if (!token) return;
  const user = login.json.data.user;
  console.log('  user role:', user.role, 'institutionId:', user.institutionId || user.institution_id);

  /* --- 1. OCR variants --- */
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'probe-'));

  // (a) text PDF
  const pdfA = path.join(tmp, 'text.pdf');
  await makePdf(pdfA, ['Certificate of Award', 'This is to certify that Test Learner', 'has completed the B.Tech programme with distinction.']);
  for (const [label, file, mime] of [
    ['text-PDF', pdfA, 'application/pdf'],
  ]) {
    const fd = new FormData();
    fd.append('document', new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
    const r = await j('POST', '/api/ocr/extract', { token, form: fd });
    console.log(`OCR ${label}:`, r.status, JSON.stringify(r.json && r.json.message), r.json && r.json.data ? 'fields=' + JSON.stringify(r.json.data.fields).slice(0, 200) : '');
  }

  // (b) empty PDF (no text - like a scanned/image-only doc)
  const pdfB = path.join(tmp, 'blank.pdf');
  await makePdf(pdfB, ['']);
  {
    const fd = new FormData();
    fd.append('document', new Blob([fs.readFileSync(pdfB)], { type: 'application/pdf' }), 'blank.pdf');
    const r = await j('POST', '/api/ocr/extract', { token, form: fd });
    console.log('OCR blank-PDF:', r.status, JSON.stringify(r.json && r.json.message));
  }

  // (c) PNG image (create tiny PNG)
  const png = path.join(tmp, 'img.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  {
    const fd = new FormData();
    fd.append('document', new Blob([fs.readFileSync(png)], { type: 'image/png' }), 'img.png');
    const r = await j('POST', '/api/ocr/extract', { token, form: fd });
    console.log('OCR PNG:', r.status, JSON.stringify(r.json && r.json.message));
  }

  // (d) no file
  {
    const fd = new FormData();
    const r = await j('POST', '/api/ocr/extract', { token, form: fd });
    console.log('OCR no-file:', r.status, JSON.stringify(r.json && r.json.message));
  }

  /* --- 2. Bulk issue --- */
  // Upload a document first so its path lands in the upload dir
  const docFile = path.join(tmp, 'bulkdoc.pdf');
  await makePdf(docFile, ['Bulk certificate document', 'Real file content for hashing.']);
  const upFd = new FormData();
  upFd.append('document', new Blob([fs.readFileSync(docFile)], { type: 'application/pdf' }), 'bulkdoc.pdf');
  const up = await j('POST', '/api/ocr/extract', { token, form: upFd }); // OCR deletes its file; need a留存 file
  console.log('OCR-then-keeps-nothing check:', up.status);

  // Check how uploads persist: issue single certificate to get a stored doc? Instead list uploads dir.
  const uploadDir = path.resolve('uploads');
  console.log('uploads dir exists:', fs.existsSync(uploadDir), fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length + ' files' : '');

  // bulk CSV with doc path columns
  const stored = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).filter((f) => f.endsWith('.pdf')) : [];
  console.log('stored pdfs:', stored.slice(0, 3));

  if (stored.length) {
    const abs = path.join(uploadDir, stored[0]);
    const csv = `studentName,registerNumber,degree,department,graduationYear,certificateType,issueDate,documentPath\nProbe Student,PRB-001,B.Tech,CS,2026,Degree,2026-01-01,"${abs.replace(/\\/g, '/')}"\n`;
    const cfd = new FormData();
    cfd.append('file', new Blob([csv], { type: 'text/csv' }), 'bulk.csv');
    const r = await j('POST', '/api/certificates/bulk', { token, form: cfd });
    console.log('BULK:', r.status, JSON.stringify(r.json).slice(0, 500));
  } else {
    console.log('BULK: skipped - no stored document to reference');
  }

  // bulk with missing documentPath (likely user's real CSV)
  {
    const csv = `studentName,registerNumber,degree,department,graduationYear,certificateType,issueDate\nProbe Student,PRB-002,B.Tech,CS,2026,Degree,2026-01-01\n`;
    const cfd = new FormData();
    cfd.append('file', new Blob([csv], { type: 'text/csv' }), 'bulk2.csv');
    const r = await j('POST', '/api/certificates/bulk', { token, form: cfd });
    console.log('BULK no-docpath:', r.status, JSON.stringify(r.json).slice(0, 400));
  }

  /* --- 3. Profile save --- */
  {
    const me = await j('GET', '/api/auth/me', { token });
    const instId = me.json.data.user.institutionId;
    const r = await j('PUT', `/api/institutions/${instId}`, { token, body: { name: 'Test Registrar Office', officialEmail: EMAIL, website: 'https://example.edu', address: '1 Exam Lane' } });
    console.log('PROFILE SAVE:', r.status, JSON.stringify(r.json).slice(0, 300));
  }

  /* --- 4. Revoke (find an active cert) --- */
  {
    const list = await j('GET', '/api/certificates?limit=20', { token });
    const active = (list.json.data.certificates || list.json.data.items || []).find((c) => (c.status || c.statusName) === 'ACTIVE');
    console.log('cert list keys:', list.json.data ? Object.keys(list.json.data) : list.status, 'active:', active ? active.certificateId || active.certificate_id : 'none');
    if (active) {
      const id = active.id;
      const r = await j('POST', `/api/certificates/${id}/revoke`, { token, body: { reason: 'Probe revocation check' } });
      console.log('REVOKE:', r.status, JSON.stringify(r.json).slice(0, 300));
    }
  }

  /* --- 5. Student linkage: does a student see issued certs? --- */
  console.log('probe done');
})().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
