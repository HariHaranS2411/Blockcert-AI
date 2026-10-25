'use strict';
/* Scratch: run the REAL interfaces end-to-end for AI tampered-detection.
 *   node test/ai-live-check.js original   -> POST /api/ai/analyze with a genuine stored certificate's file
 *   node test/ai-live-check.js forged     -> POST /api/ai/analyze with a forged PDF against a real certificate ID
 *   node test/ai-live-check.js upload     -> POST /api/verification/upload with the genuine file
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:5000';
const DEMO = { email: 'institution@demo.com', password: 'Passw0rd!x' };
const SECRET_ORIGINAL = 'uploads/1791821294730-1881919d939fe54dee3e5bf3015550ff.png';
const CERT_ID = 'CERT-2026-000020';

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DEMO),
  });
  const b = await r.json();
  const token = b && b.data && b.data.token;
  if (!token) throw new Error(`login failed: ${JSON.stringify(b).slice(0, 150)}`);
  return token;
}

async function post(token, url, file, extraFields) {
  const form = new FormData();
  form.append('document', new Blob([fs.readFileSync(file)], { type: mime(file) }), path.basename(file));
  for (const [k, v] of Object.entries(extraFields || {})) form.append(k, v);
  const started = Date.now();
  const r = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await r.json();
  return { status: r.status, seconds: ((Date.now() - started) / 1000).toFixed(1), body };
}

(async () => {
  const mode = process.argv[2] || '';
  if (!['original', 'forged', 'upload', 'forged-verify'].includes(mode)) {
    console.log('usage: node test/ai-live-check.js original|forged|upload|forged-verify');
    process.exit(2);
  }

  if (mode === 'upload' || mode === 'forged-verify') {
    const token = await login();
    const file = mode === 'upload' ? SECRET_ORIGINAL : 'test/forge-subtle.pdf';
    const r = await post(token, '/api/verification/upload', file, {});
    console.log(`HTTP ${r.status} in ${r.seconds}s`);
    const d = r.body.data || {};
    console.log('final verdict:', d.result || d.status || d.verified, '| message:', (d.message || '').slice(0, 120));
    console.log('ai:', JSON.stringify(d.ai || r.body.ai || null).slice(0, 300));
    console.log('hash:', JSON.stringify(d.hash || null).slice(0, 200));
    process.exit(0);
  }

  const token = await login();
  const file = mode === 'original' ? SECRET_ORIGINAL : 'test/forge-subtle.pdf';
  const r = await post(token, '/api/ai/analyze', file, { certificateId: CERT_ID });
  console.log(`HTTP ${r.status} in ${r.seconds}s`);
  const d = (r.body && r.body.data) || {};
  console.log('riskScore:', d.riskScore, '| classification:', d.classification, '| model:', d.model);
  (d.findings || []).forEach((f) => console.log('  - ' + String(f).slice(0, 180)));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
