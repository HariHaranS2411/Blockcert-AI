'use strict';
/* Scratch: in-process test of aiService.analyzeDocument retry + detail paths.
 * Starts a stub OpenAI-compatible server on 127.0.0.1:8741:
 *   model 'stub' (primary)            -> 429 every time
 *   model 'gemini-flash-lite-latest'  -> 200 valid JSON  => fallback succeeded
 *   later calls (persisting case)     -> 429 for every model => precise detail
 * temporarily points AI_API_BASE at the stub and restores it afterwards.
 */
process.env.DOTENV_CONFIG = ''; // avoid .env overriding our env tweaks
const http = require('http');
const path = require('path');

const start = process.env.AI_API_KEY;
if (!start) {
  require('dotenv').config();
}

(async () => {
  let calls = 0;
  const okPayload = {
    riskScore: 8,
    classification: 'Likely Authentic',
    checks: [],
    findings: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls += 1;
      const requested = (() => { try { return JSON.parse(body).model; } catch (_) { return ''; } })();
      if (requested !== 'stub') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(okPayload) }, model: requested }], model: requested }));
      } else {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited stub' } }));
      }
    });
  });
  await new Promise((r) => { server.listen(8741, '127.0.0.1', r); });

  process.env.AI_API_BASE = 'http://127.0.0.1:8741/v1';
  process.env.AI_MODEL = 'stub';
  if (!process.env.AI_API_KEY) process.env.AI_API_KEY = 'stub';

  const aiService = require('../services/aiService');

  // --- success-via-model-fallback path: primary 429 -> fallback 200 ---
  const good = await aiService.analyzeDocument({ ocrText: 'Certificate of Merit for Ahmed Khan, issued 2024.', filePath: __filename, mimetype: 'text/plain' });
  console.log(`calls used: ${calls} | result: ${good.riskScore} ${good.classification} (served by: ${good.model})`);
  if (good.model !== 'gemini-flash-lite-latest') { console.error('FALLBACK PATH FAILED'); process.exit(1); }

  // --- persisting-failure path: detail must be precise, not generic ---
  // Point the fallback list at the primary stub model itself (dedupe collapses
  // the chain) so every attempt hits the 429 stub.
  const savedFallbacks = process.env.AI_MODEL_FALLBACKS;
  process.env.AI_MODEL_FALLBACKS = 'stub';
  try {
    await aiService.analyzeDocument({ ocrText: 'still a certificate', filePath: __filename, mimetype: 'text/plain' });
    console.error('EXPECTED THROW, GOT RESULT'); process.exit(1);
  } catch (e) {
    console.log(`thrown code: ${e.code} | detail: ${e.detail}`);
    if (e.code !== 'AI_UNAVAILABLE' || !/429/.test(e.detail || '')) { console.error('DETAIL PATH FAILED'); process.exit(1); }
  }
  process.env.AI_MODEL_FALLBACKS = savedFallbacks;

  server.close();
  console.log('ai-retry-test PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
