'use strict';
/* Scratch: login as demo institution and run one live /api/ocr/extract call. */
const fs = require('fs');
const path = require('path');

(async () => {
  const base = 'http://127.0.0.1:5000';
  const file = path.resolve(process.argv[2] || 'uploads/1791821294730-1881919d939fe54dee3e5bf3015550ff.png');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'institution@demo.com', password: 'Passw0rd!x' }),
  });
  const loginBody = await login.json();
  const token = loginBody && loginBody.data && loginBody.data.token;
  if (!token) {
    console.log('LOGIN FAILED:', JSON.stringify(loginBody).slice(0, 200));
    process.exit(1);
  }

  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
  const form = new FormData();
  form.append('document', new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
  const started = Date.now();
  let res;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      res = await fetch(`${base}/api/ocr/extract`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      break;
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
  const body = await res.json();
  console.log(`HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('fields:', JSON.stringify((body.data && body.data.fields) || body));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
