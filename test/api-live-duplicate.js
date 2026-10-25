'use strict';
// End-to-end through the REAL HTTP API as the user runs it:
//   1. analyze the byte-exact original of CERT-2026-000021 (re-upload from stored doc)
//   2. analyze a re-encoded copy of the same document (same pixels, different bytes)
//   3. verify-by-upload original (hash path)
// Work directly against the stored document files.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { initDatabase, query } = require('../config/database');

const BASE = 'http://localhost:5000';
initDatabase();

async function main() {
  const u = (await query("SELECT id, role, name, institution_id FROM users WHERE role='INSTITUTION' ORDER BY id LIMIT 1")).rows[0];
  const token = jwt.sign(
    { sub: u.id, role: u.role, name: u.name, institutionId: u.institution_id },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const cert = (await query("SELECT * FROM certificates WHERE certificate_id='CERT-2026-000021'")).rows[0];
  const docPath = path.join('uploads', cert.document_path);
  const buf = fs.readFileSync(docPath);

  async function analyze(name, payload, extraFields) {
    const fd = new FormData();
    fd.append('document', new Blob([payload], { type: 'image/png' }), name);
    for (const [k, v] of Object.entries(extraFields || {})) fd.append(k, v);
    const res = await fetch(BASE + '/api/ai/analyze', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd,
    });
    const j = await res.json();
    if (!j.success) return console.log(`${name}: HTTP ${res.status} ${j.message}`);
    const d = j.data;
    console.log(`\n=== ${name} ===`);
    console.log(`riskScore ${d.riskScore} | ${d.classification} | message: ${j.message}`);
    const dup = (d.checks || []).find(c => /duplicate/i.test(c.name));
    if (dup) console.log(`  [${dup.status}] ${dup.name}: ${(dup.note || '').slice(0, 220)}`);
    (d.checks || []).filter(c => !/duplicate/i.test(c.name)).slice(0, 20).forEach(c => {
      if (c.status !== 'pass') console.log(`  [${c.status}] ${c.name}`);
    });
  }

  // 1. byte-exact original
  await analyze('document.png', buf, { certificateId: 'CERT-2026-000021' });

  // 2. re-encoded copy (JPEG re-encode of the PNG: different bytes, same pixels)
  let reencoded = null;
  try {
    const sharp = require('sharp');
    reencoded = await sharp(buf).jpeg({ quality: 88 }).png().toBuffer();
  } catch (_) {
    try {
      const jimp = require('jimp');
      const img = await jimp.read(docPath);
      reencoded = await img.quality(90).getBufferAsync('image/jpeg');
    } catch (_2) { /* no image lib */ }
  }
  if (reencoded) {
    await analyze('copy' + (require('sharp') ? '.png' : '.jpg'), reencoded, { certificateId: 'CERT-2026-000021' });
  } else {
    console.log('\n(no image lib available for the re-encode test)');
  }

  // 3. verify-by-upload with the byte-exact original
  const fd = new FormData();
  fd.append('document', new Blob([buf], { type: 'image/png' }), 'document.png');
  const res = await fetch(BASE + '/api/verification/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: fd,
  });
  const j = await res.json();
  console.log(`\n=== verify-by-upload (byte-exact) ===`);
  console.log(`HTTP ${res.status} | result ${j.data && j.data.result} | ${j.message || ''}`);

  process.exit(0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
