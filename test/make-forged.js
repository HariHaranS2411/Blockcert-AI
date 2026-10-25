'use strict';
/* Scratch: generate forged certificate PDFs to test AI tampered detection.
 * 1) test/forge-obvious.pdf  - lorem ipsum filler, impossible date, placeholder name
 * 2) test/forge-subtle.pdf   - coherent certificate but self-contradicting fields
 */
const fs = require('fs');
const PDFDocument = require('pdfkit');

function make(file, lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60 });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    for (const [text, size, bold] of lines) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(text);
      doc.moveDown(0.4);
    }
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

(async () => {
  await make('test/forge-obvious.pdf', [
    ['CERTIFICATE OF COMPLETION', 22, true],
    ['This certificate is presented to Lorem Ipsumitus in recognition of dolor sit amet.', 12, false],
    ['consectetur adipiscing elite sed do eiusmod tempor incididunt ut labore', 12, false],
    ['Lorem ipsum dolor sit amet, consectetur adipiscing elite, sed do eiusmod tempor', 11, false],
    ['incididunt ut labore et dolore magna aliqua ut enim ad minim veniam', 11, false],
    ['Date of Issue: 32/13/2026', 12, false],
    ['Registration No: TEST-0000-XXXX', 12, false],
    ['Grade: LOREM | Place: Dolor Sit', 12, false],
    ['VOID - SPECIMEN - NOT A REAL DOCUMENT', 14, true],
    ['Signature: John Doe', 12, false],
    ['ISSUING BODY: LOREM IPSUM GENERATOR LTD.', 12, false],
    ['Lorem ipsum dolor sit amet consectetur adipiscing elite sed do eiusmod', 10, false],
    ['tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam', 10, false],
  ]);
  await make('test/forge-subtle.pdf', [
    ['MAKAUT UNIVERSITY OF TECHNOLOGY, WEST BENGAL', 16, true],
    ['TRANSIENT STATEMENT OF MARKS', 14, true],
    ['This is to certify that Rahul Kumar has completed the programme', 12, false],
    ['Bachelor of Technology in COMPUTER SCIENCE in session 2021-22.', 12, false],
    ['Name of Student: Rahul Kumar', 12, true],
    ['Registration Number: 201002050001', 12, false],
    ['Degree Awarded: Bachelor of Hotel Management (BHM)', 12, false],
    ['Department: Computer Science (AI & ML difficulty-5)', 12, false],
    ['SGPA: 8.75 out of 6.0 maximum', 12, false],
    ['Date of Issue: 41-08-2025', 12, false],
    ['Awarded on: 15 grant and this certificate supersedes award AKTYRVM-2021-09877', 11, false],
    ['Controller of Examinations', 12, false],
  ]);
  console.log('wrote test/forge-obvious.pdf and test/forge-subtle.pdf');
})().catch((e) => { console.error(e); process.exit(1); });
