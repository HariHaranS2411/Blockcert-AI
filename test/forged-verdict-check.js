'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { initDatabase, query } = require('../config/database');
const BASE = 'http://localhost:5000';
initDatabase();
(async () => {
  const u = (await query("SELECT id, role, name, institution_id FROM users WHERE role='INSTITUTION' ORDER BY id LIMIT 1")).rows[0];
  const token = jwt.sign({ sub: u.id, role: u.role, name: u.name, institutionId: u.institution_id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  for (const f of ['forge-obvious.pdf', 'forge-subtle.pdf']) {
    const fd = new FormData();
    fd.append('document', new Blob([fs.readFileSync(path.join('test', f))], { type: 'application/pdf' }), f);
    const res = await fetch(BASE + '/api/ai/analyze', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const j = await res.json();
    if (!j.success) { console.log(f + ': HTTP ' + res.status + ' ' + j.message); continue; }
    const d = j.data;
    console.log(`${f}: ${d.riskScore} | ${d.classification} | verdict=${d.duplicateVerdict ? d.duplicateVerdict.verdict : 'null'} | dup=${JSON.stringify(d.duplicate)}`);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
