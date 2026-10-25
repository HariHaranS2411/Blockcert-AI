'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { initDatabase, query } = require('../config/database');
const BASE = 'http://localhost:5000';
initDatabase();
(async () => {
  const u = (await query("SELECT id, role, name, institution_id FROM users WHERE role='INSTITUTION' ORDER BY id LIMIT 1")).rows[0];
  const token = jwt.sign({ sub: u.id, role: u.role, name: u.name, institutionId: u.institution_id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const cert = (await query("SELECT * FROM certificates WHERE certificate_id='CERT-2026-000021'")).rows[0];
  const buf = fs.readFileSync(path.join('uploads', cert.document_path));

  // differing copy (JPEG re-encode -> different bytes)
  const reencoded = await sharp(buf).jpeg({ quality: 72 }).png().toBuffer();
  const fd = new FormData();
  fd.append('document', new Blob([reencoded], { type: 'image/png' }), 'copy.png');
  fd.append('certificateId', cert.certificate_id);
  const res = await fetch(BASE + '/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const j = await res.json();
  const d = j.data || {};
  const ai = d.ai || d.aiAnalysis || null;
  console.log('HTTP', res.status, '| keys:', Object.keys(d).join(','));
  if (ai) {
    console.log('AI OBJ:', JSON.stringify(ai).slice(0, 600));
  }
  if (false) {
    console.log('AI:', ai.riskScore, '|', ai.classification, '|', (ai.message || '').slice(0, 200));
    const dup = (ai.checks || []).find((c) => /duplicate/i.test(c.name));
    if (dup) console.log('  dup row:', dup.status, (dup.note || '').slice(0, 180));
  } else {
    console.log('message:', (j.message || '').slice(0, 200));
    console.log(JSON.stringify(d).slice(0, 400));
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
