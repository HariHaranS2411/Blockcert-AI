'use strict';
/* Scratch: print stored ocr_text for given certificate IDs to compare what
 * the document PRINTS against DB truth. Usage: node test/ocr-text-peek.js CERT-...
 */
require('dotenv').config();
const { initDatabase, isDatabaseConfigured, query } = require('../config/database');

async function main() {
  initDatabase();
  if (!isDatabaseConfigured()) { console.error('DB not configured'); process.exit(2); }
  const ids = process.argv.slice(2);
  const res = await query(
    `SELECT certificate_id, student_name, degree, marks, left(ocr_text, 700) AS text
       FROM certificates WHERE certificate_id = ANY($1) ORDER BY id`,
    [ids]
  );
  for (const r of res.rows) {
    console.log(`--- ${r.certificate_id}  DB truth: name=${JSON.stringify(r.student_name)} degree=${JSON.stringify(r.degree)} marks=${JSON.stringify(r.marks)}`);
    console.log((r.text || '').replace(/\\n/g, ' | '));
    console.log('');
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
