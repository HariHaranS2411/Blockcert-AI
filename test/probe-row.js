'use strict';
require('dotenv').config();
const { initDatabase, query } = require('../config/database');

(async () => {
  initDatabase();
  const id = process.argv[2] || 'CERT-2026-000025';
  const r = await query(
    'SELECT certificate_id, document_path, document_mime FROM certificates WHERE certificate_id = $1',
    [id]
  );
  console.log(JSON.stringify(r.rows[0] ? r.rows[0] : null));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
