'use strict';
/**
 * End-to-end test - REAL operations only.
 * Requires: PostgreSQL (DATABASE_URL), Ganache (7545), deployed contract,
 * and the server running on PORT.
 *
 * Flow: fresh-install counts → register institution → login → create real PDF
 * → issue on-chain → verify ID → modify PDF → upload mismatch → revoke →
 * REVOKED result → student scoping → employer bulk → admin approval → AI
 * unavailable honesty → audit logs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const BASE = process.env.TEST_BASE || 'http://localhost:5000';
let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    failures.push(label + (extra ? ' :: ' + extra : ''));
    console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : ''));
  }
}

async function req(method, urlPath, { token, body, form, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + urlPath, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* html */
  }
  if (raw) return { status: res.status, json, text, headers: res.headers };
  return { status: res.status, json };
}

function makePdf(filePath, lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.fontSize(24).font('Helvetica-Bold').text(lines.title, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica');
    for (const line of lines.body) {
      doc.text(line, { align: 'left' });
      doc.moveDown(0.3);
    }
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const tmp = path.join(__dirname, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });

  console.log('\n=== 1. Fresh install must show real zeros ===');
  const health = await req('GET', '/api/health');
  ok(health.status === 200 && health.json.success, 'health endpoint responds');
  ok(health.json.data.database.connected === true, 'database connected');

  const counts = await req('GET', '/api/dashboard/public');
  ok(counts.status === 200, 'public counts endpoint');
  const c = counts.json.data.counts;
  ok(c.certificates === 0, 'Certificates 0', 'got ' + c.certificates);
  ok(c.institutions === 0, 'Institutions 0', 'got ' + c.institutions);
  ok(c.verifications === 0, 'Verifications 0', 'got ' + c.verifications);

  console.log('\n=== 2. Honest AI unavailable state (no key configured) ===');
  const aiHealth = health.json.data.ai;
  ok(aiHealth.configured === false, 'AI reported as not configured');

  console.log('\n=== 3. Public verification of unknown ID ===');
  const notFound = await req('POST', '/api/verification/id', { body: { certificateId: 'CERT-2026-999999' } });
  ok(notFound.status === 200, 'unknown ID returns 200 with result');
  ok(notFound.json.data.finalResult === 'NOT_FOUND', 'unknown ID → NOT_FOUND');
  ok(notFound.json.data.message === 'Certificate Not Found.', 'honest not-found message');

  console.log('\n=== 4. Register institution + employer + student ===');
  const stamp = Date.now();
  const instEmail = `registrar${stamp}@example.edu`;
  const inst = await req('POST', '/api/auth/register', {
    body: {
      name: 'Test Registrar Office',
      email: instEmail,
      password: 'Passw0rd!x',
      role: 'INSTITUTION',
      institutionName: `Examination Board ${stamp}`,
      website: 'https://example.edu',
      address: '1 Exam Lane',
    },
  });
  ok(inst.status === 201, 'institution registered', JSON.stringify(inst.json));
  const instToken = inst.json && inst.json.data.token;
  ok(Boolean(instToken), 'institution token issued');
  ok(inst.json.data.user.role === 'INSTITUTION', 'role is INSTITUTION');
  ok(inst.json.data.user.institution, 'institution created with the account');

  const employer = await req('POST', '/api/auth/register', {
    body: { name: 'HR Tester', email: `hr${stamp}@corp.example`, password: 'Passw0rd!x', role: 'EMPLOYER' },
  });
  ok(employer.status === 201, 'employer registered');
  const employerToken = employer.json.data.token;

  const student = await req('POST', '/api/auth/register', {
    body: {
      name: 'Student One',
      email: `student${stamp}@mail.example`,
      password: 'Passw0rd!x',
      role: 'STUDENT',
      registrationNumber: 'REG-2026-001',
    },
  });
  ok(student.status === 201, 'student registered with registration number', JSON.stringify(student.json).slice(0, 200));
  const studentToken = student.json.data.token;
  const studentId = student.json.data.user.id;

  const badLogin = await req('POST', '/api/auth/login', { body: { email: instEmail, password: 'wrong' } });
  ok(badLogin.status === 401, 'wrong password rejected');

  console.log('\n=== 4b. Forgot password reports the real (unconfigured) state ===');
  const forgot = await req('POST', '/api/auth/forgot-password', { body: { email: instEmail } });
  ok(forgot.status === 503, 'forgot-password returns honest 503 when no email service exists', 'got ' + forgot.status);
  ok(
    forgot.json.message === 'Password reset by email is not configured on this server. Contact your administrator to reset your password.',
    'honest forgot-password message',
    forgot.json.message
  );
  ok(forgot.json.data && forgot.json.data.emailDeliveryConfigured === false, 'emailDeliveryConfigured reported false');
  ok(!('accountExists' in (forgot.json.data || {})), 'response does not reveal whether the account exists');
  const forgotMissing = await req('POST', '/api/auth/forgot-password', { body: { email: 'nobody@nowhere.invalid' } });
  ok(
    forgotMissing.json.message === forgot.json.message,
    'identical response for unknown account (no enumeration)'
  );

  console.log('\n=== 5. Unauthorized access is blocked ===');
  const noAuth = await req('GET', '/api/certificates');
  ok(noAuth.status === 401, 'certificate list requires auth');
  const studentList = await req('GET', '/api/certificates', { token: studentToken });
  ok(studentList.status === 403, 'student cannot list all certificates', 'got ' + studentList.status);
  const adminOnly = await req('GET', '/api/admin/dashboard', { token: instToken });
  ok(adminOnly.status === 403, 'institution cannot access admin API');

  const createInstNoAuth = await req('POST', '/api/institutions', {
    body: { name: 'Unlinked', officialEmail: `x${stamp}@example.edu` },
  });
  ok(createInstNoAuth.status === 401, 'POST /api/institutions requires auth');

  console.log('\n=== 6. Admin setup script creates the only admin ===');
  const adminEmail = `admin${stamp}@blockcert.local`;
  const { execSync } = require('child_process');
  try {
    execSync(`node scripts/create-admin.js "Site Admin" ${adminEmail} "Adm1nPass!x"`, {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: 'pipe',
    });
    ok(true, 'admin created via explicit setup script');
  } catch (err) {
    ok(false, 'admin created via explicit setup script', err.message);
  }
  const adminLogin = await req('POST', '/api/auth/login', { body: { email: adminEmail, password: 'Adm1nPass!x' } });
  ok(adminLogin.status === 200 && adminLogin.json.data.user.role === 'ADMIN', 'admin login works');
  const adminToken = adminLogin.json.data.token;

  console.log('\n=== 7. Institution must be approved before issuer is verified ===');
  const instId = inst.json.data.user.institutionId;
  let instList = await req('GET', '/api/admin/institutions', { token: adminToken });
  ok(instList.status === 200, 'admin lists institutions');
  const meBefore = await req('GET', '/api/auth/me', { token: instToken });
  ok(meBefore.json.data.user.institution.verification_status === 'PENDING', 'new institution is PENDING');

  const approve = await req('PATCH', `/api/admin/institutions/${instId}/approve`, { token: adminToken, body: {} });
  ok(approve.status === 200, 'admin approves institution');
  const meAfter = await req('GET', '/api/auth/me', { token: instToken });
  ok(meAfter.json.data.user.institution.verification_status === 'APPROVED', 'institution now APPROVED');

  console.log('\n=== 8. Issue a real certificate on-chain ===');
  const pdfA = path.join(tmp, 'cert-original.pdf');
  await makePdf(pdfA, {
    title: 'Certificate of Graduation',
    body: [
      'This is to certify that',
      'Student One',
      'has completed the requirements of',
      'Bachelor of Technology in Computer Science',
      'Register Number: REG-2026-001',
      'Issue Date: 2026-01-15',
      'CGPA: 8.7',
    ],
  });
  const pdfAHash = sha256(fs.readFileSync(pdfA));

  const form = new FormData();
  form.append('document', new Blob([fs.readFileSync(pdfA)], { type: 'application/pdf' }), 'cert-original.pdf');
  form.append('studentName', 'Student One');
  form.append('registrationNumber', 'REG-2026-001');
  form.append('degree', 'B.Tech Computer Science');
  form.append('department', 'Computer Science');
  form.append('certificateType', 'Degree');
  form.append('academicYear', '2022-2026');
  form.append('marks', '8.7');
  form.append('issueDate', '2026-01-15');

  const issued = await req('POST', '/api/certificates', { token: instToken, form });
  ok(issued.status === 201, 'certificate issued', JSON.stringify(issued.json).slice(0, 300));
  const cert = issued.json && issued.json.data && issued.json.data.certificate;
  ok(Boolean(cert), 'certificate returned');
  if (!cert) {
    return finish();
  }
  ok(/^CERT-\d{4}-\d{6}$/.test(cert.certificateId), 'certificate ID format CERT-YYYY-XXXXXX', cert.certificateId);
  ok(cert.documentHash === pdfAHash, 'stored SHA-256 matches the real file', cert.documentHash + ' vs ' + pdfAHash);
  ok(cert.blockchainStatus === 'registered', 'registered on-chain', cert.blockchainStatus);
  ok(Boolean(cert.blockchainTxHash), 'real tx hash stored');
  ok(typeof cert.blockNumber === 'number', 'real block number stored', String(cert.blockNumber));
  ok(cert.status === 'ACTIVE', 'certificate ACTIVE');

  const issuedData = issued.json.data;
  ok(Boolean(issuedData.qrDataUrl), 'QR code generated');

  console.log('\n=== 9. Verify by ID (record + blockchain, no document claim) ===');
  const vById = await req('POST', '/api/verification/id', { body: { certificateId: cert.certificateId } });
  ok(vById.status === 200, 'id verification runs');
  ok(vById.json.data.finalResult === 'VERIFIED', 'ID verification → VERIFIED', vById.json.data.finalResult);
  ok(vById.json.data.documentChecked === false, 'does not claim document was checked');
  ok(vById.json.data.blockchain.recordFound === true, 'blockchain record found');
  ok(vById.json.data.issuer.verified === true, 'issuer verified (approved institution)');
  ok(vById.json.data.ai.performed === false, 'AI not performed without a document');

  console.log('\n=== 10. Verify by original upload → match ===');
  const formVerify = new FormData();
  formVerify.append('document', new Blob([fs.readFileSync(pdfA)], { type: 'application/pdf' }), 'orig.pdf');
  const vUpload = await req('POST', '/api/verification/upload', { form: formVerify });
  ok(vUpload.status === 200, 'upload verification runs');
  ok(vUpload.json.data.finalResult === 'VERIFIED', 'original upload → VERIFIED', vUpload.json.data.finalResult);
  ok(vUpload.json.data.hash.performed && vUpload.json.data.hash.match === true, 'SHA-256 MATCH reported');
  ok(vUpload.json.data.ai.available === false, 'AI marked unavailable (no key), no fake score', JSON.stringify(vUpload.json.data.ai));
  ok(vUpload.json.data.ai.riskScore === undefined, 'no fabricated risk score present');

  console.log('\n=== 11. Modify the PDF → real hash mismatch ===');
  const pdfB = path.join(tmp, 'cert-modified.pdf');
  await makePdf(pdfB, {
    title: 'Certificate of Graduation',
    body: [
      'This is to certify that',
      'Student One',
      'has completed the requirements of',
      'Bachelor of Technology in Computer Science',
      'Register Number: REG-2026-001',
      'Issue Date: 2026-01-15',
      'CGPA: 9.9',
    ],
  });
  const pdfBHash = sha256(fs.readFileSync(pdfB));
  ok(pdfBHash !== pdfAHash, 'modified file produces a different SHA-256');

  const formTamper = new FormData();
  formTamper.append('document', new Blob([fs.readFileSync(pdfB)], { type: 'application/pdf' }), 'mod.pdf');
  formTamper.append('certificateId', cert.certificateId);
  const vTamper = await req('POST', '/api/verification/upload', { form: formTamper });
  ok(vTamper.status === 200, 'tampered upload verification runs');
  ok(vTamper.json.data.finalResult === 'TAMPERED', 'modified upload → TAMPERED', vTamper.json.data.finalResult);
  ok(vTamper.json.data.hash.match === false, 'SHA-256 MISMATCH reported');
  ok(vTamper.json.data.blockchain.recordFound === true, 'chain record still found for comparison');

  console.log('\n=== 12. QR verification (public URL only) ===');
  const qrRes = await req('GET', `/api/qr/${cert.certificateId}`, { raw: true });
  ok(qrRes.status === 200 && (qrRes.headers.get('content-type') || '').includes('image/png'), 'QR PNG served');
  const vQr = await req('POST', '/api/verification/qr', {
    body: { qrData: `${BASE}/verify.html?id=${cert.certificateId}` },
  });
  ok(vQr.status === 200 && vQr.json.data.finalResult === 'VERIFIED', 'QR verification → VERIFIED', JSON.stringify(vQr.json).slice(0, 200));
  const qrBad = await req('POST', '/api/verification/qr', { body: { qrData: 'https://example.com/nothing' } });
  ok(qrBad.status === 400, 'foreign QR content rejected');

  console.log('\n=== 13. Revoke on-chain → REVOKED ===');
  const revoke = await req('POST', `/api/certificates/${cert.id}/revoke`, {
    token: instToken,
    body: { reason: 'Issued with incorrect marks after re-evaluation' },
  });
  ok(revoke.status === 200, 'revocation accepted', JSON.stringify(revoke.json).slice(0, 300));
  ok(Boolean(revoke.json && revoke.json.data.txHash), 'real revocation tx hash');

  const vRevoked = await req('POST', '/api/verification/id', { body: { certificateId: cert.certificateId } });
  ok(vRevoked.json.data.finalResult === 'REVOKED', 'verification → REVOKED', vRevoked.json.data.finalResult);
  ok(vRevoked.json.data.revocation.revoked === true, 'revocation flagged');
  ok(vRevoked.json.data.revocation.reason === 'Issued with incorrect marks after re-evaluation', 'real revocation reason shown');

  const rowAfter = await req('GET', `/api/certificates/${cert.id}`, { token: instToken });
  ok(rowAfter.json.data.certificate.status === 'REVOKED', 'record retained as REVOKED (not deleted)');
  ok(rowAfter.json.data.revocations.length === 1, 'revocation history row kept');

  console.log('\n=== 14. Cross-tenant ownership enforcement ===');
  const inst2 = await req('POST', '/api/auth/register', {
    body: {
      name: 'Other University',
      email: `other${stamp}@example.edu`,
      password: 'Passw0rd!x',
      role: 'INSTITUTION',
      institutionName: `Other University ${stamp}`,
    },
  });
  const inst2Token = inst2.json.data.token;
  const crossView = await req('GET', `/api/certificates/${cert.id}`, { token: inst2Token });
  ok(crossView.status === 403, 'other institution cannot view this certificate', 'got ' + crossView.status);
  const crossRevoke = await req('POST', `/api/certificates/${cert.id}/revoke`, {
    token: inst2Token,
    body: { reason: 'attempted cross-tenant revoke' },
  });
  ok(crossRevoke.status === 403, 'other institution cannot revoke this certificate', 'got ' + crossRevoke.status);

  console.log('\n=== 15. Student sees only their own certificates ===');
  const myCerts = await req('GET', '/api/students/me/certificates', { token: studentToken });
  ok(myCerts.status === 200, 'student list works');
  ok(myCerts.json.data.certificates.length === 1, 'certificate linked to the student via registration number', 'got ' + myCerts.json.data.certificates.length);
  if (myCerts.json.data.certificates.length) {
    ok(myCerts.json.data.certificates[0].certificateId === cert.certificateId, 'linked certificate is the issued one');
    ok(myCerts.json.data.certificates[0].status === 'REVOKED', 'student sees the real REVOKED status');
  }
  const pubProfile = await req('GET', `/api/students/${studentId}/public-profile`);
  ok(pubProfile.status === 200, 'public credential profile reachable without login');
  ok(pubProfile.json.data.profile.credentials.length === 1, 'public profile lists the real credential');
  ok(pubProfile.json.data.profile.credentials.every((x) => !('email' in x)), 'profile has no private fields');

  console.log('\n=== 16. Verification history & audit are real ===');
  const instHistory = await req('GET', '/api/verification/history', { token: instToken });
  ok(instHistory.status === 200, 'institution sees history');
  ok(instHistory.json.data.history.length >= 4, 'several real verification events recorded', String(instHistory.json.data.history.length));
  const summary = instHistory.json.data.summary;
  ok(summary.tampered >= 1 && summary.revoked >= 1 && summary.verified >= 1, 'summary counts real results', JSON.stringify(summary));

  const audit = await req('GET', '/api/admin/audit-logs', { token: adminToken });
  ok(audit.status === 200, 'audit logs accessible to admin');
  const actions = audit.json.data.logs.map((l) => l.action);
  ok(actions.includes('certificate.issued'), 'issuance audited');
  ok(actions.includes('certificate.revoked'), 'revocation audited');
  ok(actions.includes('auth.register'), 'registration audited');

  console.log('\n=== 17. Employer bulk verification (CSV) ===');
  const csv = `certificateId\n${cert.certificateId}\nCERT-2026-999999\n`;
  const bulkForm = new FormData();
  bulkForm.append('file', new Blob([csv], { type: 'text/csv' }), 'ids.csv');
  const bulk = await req('POST', '/api/verification/bulk', { token: employerToken, form: bulkForm });
  ok(bulk.status === 200, 'bulk verification runs', JSON.stringify(bulk.json).slice(0, 200));
  ok(bulk.json.data.summary.REVOKED === 1, 'bulk reports REVOKED row');
  ok(bulk.json.data.summary.NOT_FOUND === 1, 'bulk reports NOT_FOUND row');
  ok(bulk.json.data.results.length === 2, 'per-row real results');

  const employerHistory = await req('GET', '/api/employer/history', { token: employerToken });
  ok(employerHistory.status === 200, 'employer history endpoint');
  const bulkTemplate = await req('GET', '/api/employer/bulk-template', { token: employerToken, raw: true });
  ok(bulkTemplate.status === 200 && bulkTemplate.text.includes('certificateId'), 'CSV template served');

  // Spec route: POST /api/employer/bulk-verify (same real pipeline)
  const empBulkForm = new FormData();
  empBulkForm.append('file', new Blob([`certificateId\n${cert.certificateId}\n`], { type: 'text/csv' }), 'ids.csv');
  const empBulk = await req('POST', '/api/employer/bulk-verify', { token: employerToken, form: empBulkForm });
  ok(empBulk.status === 200, 'POST /api/employer/bulk-verify works', JSON.stringify(empBulk.json).slice(0, 200));
  if (empBulk.json && empBulk.json.data) {
    ok(empBulk.json.data.summary.REVOKED === 1, 'employer bulk reports the real REVOKED row');
  }
  const empBulkNoAuth = await req('POST', '/api/employer/bulk-verify', { form: empBulkForm });
  ok(empBulkNoAuth.status === 401, 'employer bulk requires auth');

  console.log('\n=== 18. Admin dashboard real counts ===');
  const dash = await req('GET', '/api/admin/dashboard', { token: adminToken });
  ok(dash.status === 200, 'admin dashboard loads');
  const d = dash.json.data;
  ok(d.users.total >= 4, 'user count is real', String(d.users.total));
  ok(d.institutions.total >= 2, 'institution count is real', String(d.institutions.total));
  ok(d.certificates.total === 1, 'certificate count is real', String(d.certificates.total));
  ok(d.certificates.revoked === 1, 'revoked count real');
  ok(d.verifications.total >= 5, 'verification count real', String(d.verifications.total));
  ok(d.auditLogs.total >= 5, 'audit log count real', String(d.auditLogs.total));
  ok(d.systemHealth.blockchain.connected === true, 'blockchain health reported');

  console.log('\n=== 19. AI endpoints honest when unconfigured ===');
  const aiForm = new FormData();
  aiForm.append('document', new Blob([fs.readFileSync(pdfA)], { type: 'application/pdf' }), 'x.pdf');
  const aiRes = await req('POST', '/api/ai/analyze', { token: instToken, form: aiForm });
  ok(aiRes.status === 503, 'AI analyze returns 503 when no key', 'got ' + aiRes.status);
  ok(aiRes.json.message === 'AI analysis is currently unavailable.', 'honest AI unavailable message', aiRes.json.message);
  ok(!('riskScore' in (aiRes.json.data || {})), 'no fabricated risk score in unavailable response');

  const aiGet = await req('GET', `/api/ai/${cert.certificateId}`, { token: instToken });
  ok(aiGet.status === 200, 'AI history endpoint works');
  ok(Array.isArray(aiGet.json.data.analyses), 'analyses array present');

  console.log('\n=== 20. OCR extraction on real PDF ===');
  const ocrForm = new FormData();
  ocrForm.append('document', new Blob([fs.readFileSync(pdfA)], { type: 'application/pdf' }), 'ocr.pdf');
  const ocr = await req('POST', '/api/ocr/extract', { token: instToken, form: ocrForm });
  ok(ocr.status === 200, 'OCR extract succeeds on real PDF', JSON.stringify(ocr.json).slice(0, 200));
  if (ocr.json && ocr.json.data) {
    ok(typeof ocr.json.data.text === 'string' && ocr.json.data.text.includes('Certificate'), 'real text extracted from PDF');
  }

  console.log('\n=== 21. Duplicate document hash rejected ===');
  const dupForm = new FormData();
  dupForm.append('document', new Blob([fs.readFileSync(pdfA)], { type: 'application/pdf' }), 'dup.pdf');
  dupForm.append('studentName', 'Student One');
  dupForm.append('registrationNumber', 'REG-2026-002');
  dupForm.append('degree', 'B.Tech Mechanical');
  dupForm.append('certificateType', 'Degree');
  dupForm.append('issueDate', '2026-01-15');
  const dup = await req('POST', '/api/certificates', { token: instToken, form: dupForm });
  ok(dup.status === 409, 'duplicate document hash rejected with 409', 'got ' + dup.status);

  console.log('\n=== 22. Second issuance (fresh doc) + student linkage via hash ===');
  const pdfC = path.join(tmp, 'cert-second.pdf');
  await makePdf(pdfC, {
    title: 'Course Completion',
    body: ['This is to certify that', 'Student One', 'completed Advanced Databases', 'Register Number: REG-2026-001'],
  });
  const form2 = new FormData();
  form2.append('document', new Blob([fs.readFileSync(pdfC)], { type: 'application/pdf' }), 'second.pdf');
  form2.append('studentName', 'Student One');
  form2.append('registrationNumber', 'REG-2026-001');
  form2.append('degree', 'Advanced Databases Course');
  form2.append('certificateType', 'Course');
  form2.append('issueDate', '2026-02-01');
  const second = await req('POST', '/api/certificates', { token: instToken, form: form2 });
  ok(second.status === 201, 'second certificate issued', JSON.stringify(second.json).slice(0, 250));
  if (second.status === 201) {
    const c2 = second.json.data.certificate;
    ok(c2.certificateId !== cert.certificateId, 'unique certificate ID allocated');
    ok(c2.blockchainStatus === 'registered', 'second cert registered on-chain');
  }

  console.log('\n=== 24. Bulk issuance with attached documents + template + retroactive student linkage ===');
  const tpl = await req('GET', '/api/certificates/bulk-template', { token: instToken, raw: true });
  ok(tpl.status === 200, 'bulk CSV template served', 'got ' + tpl.status);
  ok(
    tpl.text.startsWith('studentName,registerNumber,degree,department,graduationYear,certificateType,issueDate,documentPath'),
    'bulk template has the required header row only (no fake rows)',
    tpl.text.slice(0, 120)
  );

  const cspRes = await fetch(BASE + '/login.html');
  const csp = cspRes.headers.get('content-security-policy') || '';
  ok(csp.includes("frame-src"), 'CSP allows document previews (frame-src declared)');
  ok(csp.includes('blob:'), 'CSP frame-src permits blob: PDF previews');

  const pdfBulk = path.join(tmp, 'bulk-attach.pdf');
  await makePdf(pdfBulk, {
    title: 'Bulk Issued Certificate',
    body: ['This is to certify that', 'Bulk Row Student', 'completed the programme', 'Register Number: BULK-REG-001'],
  });
  const attachRowReg = 'BULK-REG-' + stamp;
  const bulkAttachCsv = `studentName,registerNumber,degree,department,graduationYear,certificateType,issueDate,documentPath\nBulk Row Student,${attachRowReg},B.Sc Real Data,Physics,2026,Degree,2026-03-01,bulk-attach.pdf\nGhost Row Student,GHOST-REG-${stamp},B.A General,,2026,Degree,2026-03-01,missing-file-${stamp}.pdf\n`;
  const bulkAttachForm = new FormData();
  bulkAttachForm.append('file', new Blob([bulkAttachCsv], { type: 'text/csv' }), 'bulk.csv');
  bulkAttachForm.append('documents', new Blob([fs.readFileSync(pdfBulk)], { type: 'application/pdf' }), 'bulk-attach.pdf');
  let bulkIssuedCertId = null;
  const bulkAttach = await req('POST', '/api/certificates/bulk', { token: instToken, form: bulkAttachForm });
  ok(bulkAttach.status === 200, 'bulk issuance processes CSV with attached documents', JSON.stringify(bulkAttach.json).slice(0, 250));
  if (bulkAttach.json && bulkAttach.json.data) {
    ok(bulkAttach.json.data.succeeded === 1 && bulkAttach.json.data.failed === 1, 'per-row real results: 1 issued, 1 failed', JSON.stringify(bulkAttach.json.data.results));
    const okRow = bulkAttach.json.data.results.find((r) => r.status === 'issued');
    const badRow = bulkAttach.json.data.results.find((r) => r.status === 'failed');
    ok(okRow && okRow.blockchain && okRow.blockchain.registered === true, 'attached-document row registered on-chain');
    ok(badRow && /documentPath/i.test(badRow.error || ''), 'missing document row fails with actionable documentPath error', badRow && badRow.error);
    if (okRow) bulkIssuedCertId = okRow.certificateId;
  }

  // A student registering AFTER issuance claims the unlinked certificate by
  // exact registration number (retroactive linkage, same rule as issue time).
  const lateStudentEmail = `late-student${stamp}@mail.example`;
  const attachReg = await req('POST', '/api/auth/register', {
    body: { name: 'Bulk Row Student', email: lateStudentEmail, password: 'Passw0rd!x', role: 'STUDENT', registrationNumber: attachRowReg },
  });
  ok(attachReg.status === 201, 'student registration after bulk issuance succeeds', JSON.stringify(attachReg.json).slice(0, 200));
  const attachStudentToken = attachReg.json.data && attachReg.json.data.token;
  const attachStudentCerts = await req('GET', '/api/students/me/certificates', { token: attachStudentToken });
  ok(attachStudentCerts.status === 200, 'student certificate endpoint works');
  ok(
    bulkIssuedCertId && attachStudentCerts.json.data.certificates.some((c) => c.certificateId === bulkIssuedCertId),
    'retroactively linked bulk-issued certificate visible to the student',
    JSON.stringify(attachStudentCerts.json.data.certificates.map((c) => c.certificateId))
  );

  console.log('\n=== 23. Frontend pages served ===');
  for (const page of ['/', '/index.html', '/login.html', '/signup.html', '/forgot-password.html', '/verify.html', '/how-it-works.html', '/about.html', '/issue-certificate.html', '/student-dashboard.html', '/institution-dashboard.html', '/employer-dashboard.html', '/admin-dashboard.html', '/certificate-details.html', '/verification-result.html', '/ai-analysis.html', '/credential-profile.html', '/verification-history.html']) {
    const r = await fetch(BASE + page);
    ok(r.status === 200, 'page 200: ' + page, 'got ' + r.status);
  }
  const css = await fetch(BASE + '/css/style.css');
  ok(css.status === 200, 'style.css served');
  const qrVendor = await fetch(BASE + '/vendor/qr-scanner/qr-scanner.min.js');
  ok(qrVendor.status === 200, 'vendored qr-scanner library served', 'got ' + qrVendor.status);
  for (const js of ['main', 'auth', 'verify', 'issue', 'student', 'institution', 'employer', 'admin', 'ai-analysis', 'certificate', 'profile', 'history', 'dashboard', 'common', 'result', 'qr']) {
    const r = await fetch(BASE + '/js/' + js + '.js');
    ok(r.status === 200, 'js 200: ' + js + '.js', 'got ' + r.status);
  }

  return finish();

  function finish() {
    console.log('\n========================================');
    console.log(`PASSED: ${passed}   FAILED: ${failed}`);
    if (failed) {
      console.log('Failures:');
      failures.forEach((f) => console.log('  - ' + f));
    }
    console.log('========================================');
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
