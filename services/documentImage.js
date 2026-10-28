'use strict';

/**
 * Prepares the uploaded document as an attachable image for the
 * vision-capable fraud-analysis call.
 *
 * - PNG/JPG uploads: read + (optionally downscale) to a JPEG, cap ~2.5 MB
 *   base64 (Gemini vision input).
 * - PDFs: render PAGE 1 with pdfjs-dist (legacy build) onto an
 *   @napi-rs/canvas bitmap (prebuilt native binaries - no node-gyp pain)
 *   and JPEG-encode that.
 *
 * Returns { mime:'image/jpeg', dataUri } or null when the file cannot be
 * prepared. NEVER throws: vision is an enhancement; the analysis pipeline
 * must keep its text-only fallback path.
 */

const fs = require('fs');
const path = require('path');

const TARGET_WIDTHS = [1400, 1100, 900];
const MAX_JPEG_BYTES = 2.2 * 1024 * 1024; // dataUri headroom under ~3 MB request payload

let sharpModule;
function getSharp() {
  if (sharpModule === undefined) {
    try { sharpModule = require('sharp'); } catch (_) { sharpModule = null; }
  }
  return sharpModule;
}

let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

let napiCanvasModule;
function getNapiCanvas() {
  if (napiCanvasModule === undefined) {
    try {
      napiCanvasModule = require('@napi-rs/canvas');
      const napi = napiCanvasModule;
      /* pdfjs-dist's legacy build polyfills globalThis.Path2D/ImageData/DOMMatrix
         from its OWN `require("@napi-rs/canvas")`, which can resolve to a
         DIFFERENT module instance than ours (npm nesting). Glyph paths are
         then built with pdfjs's Path2D class while our canvas context only
         accepts instances of our class -> rendering throws "'[object Object]'
         is not a valid enum value of type CanvasFillRule". Assign OUR globals
         before pdfjs is imported; pdfjs only polyfills what is missing. */
      for (const [key, val] of [['DOMMatrix', napi.DOMMatrix], ['ImageData', napi.ImageData], ['Path2D', napi.Path2D]]) {
        if (val && globalThis[key] !== val) globalThis[key] = val;
      }
    } catch (_) {
      napiCanvasModule = null;
    }
  }
  return napiCanvasModule;
}

function standardFontDataUrl() {
  try {
    return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  } catch (_) {
    return undefined;
  }
}

/** JPEG-encode a source buffer at each candidate width until under the cap. */
async function encodeJpeg(buffer) {
  const sharp = getSharp();
  if (!sharp) return null;
  for (const width of TARGET_WIDTHS) {
    for (const quality of [82, 68]) {
      const out = await sharp(buffer)
        .rotate() // honour EXIF orientation; vision reads the photo as stored
        .resize({ width: Math.min(width, 2200), withoutEnlargement: true, kernel: 'lanczos3' })
        .jpeg({ quality })
        .toBuffer();
      // Small base64 turnaround: 2^22 * 4/3 ≈ 5.6 MB; cap conservatively.
      if (out.length <= MAX_JPEG_BYTES) {
        return { mime: 'image/jpeg', dataUri: `data:image/jpeg;base64,${out.toString('base64')}` };
      }
    }
  }
  return null;
}

async function pdfToImage(filePath) {
  const canvasModule = getNapiCanvas();
  if (!canvasModule || !canvasModule.createCanvas) return null;
  const pdfjsLib = await getPdfjs();
  const original = await fs.promises.readFile(filePath);
  // pdf.js takes ownership of the ArrayBuffer handed to it: pass a copy.
  const data = new Uint8Array(original.slice(0));
  const doc = await pdfjsLib.getDocument({
    data,
    standardFontDataUrl: standardFontDataUrl(),
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
    // pdfjs's Node path polyfills globalThis.Path2D/ImageData FROM this
    // module, which ctx.fill(pathObject) needs when fonts render as paths
    // (without it rendering throws "'[object Object]' is not a valid enum
    // value of type CanvasFillRule").
    canvas: canvasModule,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    // Aim for ~1400 px wide bitmap so fine print stays legible to the model.
    const scale = Math.max(1, Math.min(4, 1400 / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    // PDF page can rely on viewer transparency: fill white first.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const png = await canvas.encode('png');
    if (typeof page.cleanup === 'function') page.cleanup();
    return encodeJpeg(png);
  } finally {
    if (typeof doc.destroy === 'function') await doc.destroy().catch(() => {});
  }
}

let lastError = null;

/**
 * Public entry: returns { mime, dataUri } for the first page of the
 * document, or null. Never throws. lastError() exposes why the last
 * attempt returned null (diagnostics only).
 */
async function prepareDocumentImage(filePath, mimetype) {
  try {
    if (mimetype === 'application/pdf') {
      const out = await pdfToImage(filePath);
      if (out) lastError = null;
      return out;
    }
    const out2 = await encodeJpeg(await fs.promises.readFile(filePath));
    if (out2) lastError = null;
    return out2;
  } catch (e) {
    lastError = e;
    return null;
  }
}

function getLastError() {
  return lastError;
}

/**
 * Warm the lazy vision plumbing (sharp, @napi-rs/canvas, first pdfjs import)
 * in the background at startup so the first AI analysis of an uploaded
 * document after a cold start pays no module-load cost. Failures are
 * swallowed: the normal lazy paths retry exactly as before.
 */
async function warmup() {
  getSharp();
  getNapiCanvas();
  try { await getPdfjs(); } catch (_) { /* imports lazily on first PDF as before */ }
}

module.exports = { prepareDocumentImage, getLastError, warmup };
