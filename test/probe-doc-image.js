'use strict';
/* Scratch: diagnose services/documentImage.prepareDocumentImage on a given
 * file. Usage: node test/probe-doc-image.js <file> [mime]
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');

(async () => {
  const { prepareDocumentImage, getLastError } = require('../services/documentImage');
  const file = process.argv[2];
  if (!file) { console.error('usage: node test/probe-doc-image.js <file>'); process.exit(2); }
  const abs = path.resolve(file);
  const mime = process.argv[3] || (abs.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png');

  const out = await prepareDocumentImage(abs, mime);
  if (out) {
    const bytes = Buffer.byteLength(out.dataUri.slice(out.dataUri.indexOf(',') + 1), 'base64');
    console.log('prepareDocumentImage OK:', out.mime, 'bytes:', bytes);
    fs.writeFileSync('.freebuff/doc-image-test.jpg', Buffer.from(out.dataUri.split(',')[1], 'base64'));
    console.log('wrote .freebuff/doc-image-test.jpg (inspect it in an image viewer)');
  } else {
    const e = getLastError();
    console.log('prepareDocumentImage FAIL. error:', e && e.name, e && e.message);
    console.log(e && e.stack && e.stack.split('\n').slice(1, 7).join('\n'));
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.name, e.message); process.exit(1); });
