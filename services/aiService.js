'use strict';

/**
 * Real AI fraud-detection service.
 *
 * Calls a real AI provider (OpenAI-compatible chat completions) configured via
 * AI_API_KEY / AI_API_BASE / AI_MODEL, passing the actual OCR text extracted
 * from the uploaded document. No score is ever fabricated: if the provider is
 * not configured or the call fails, analysis_status is stored as 'unavailable'
 * and the UI shows "AI analysis is currently unavailable."
 */

const fs = require('fs');
const path = require('path');

const LOW_THRESHOLD = () => Number(process.env.AI_RISK_SUSPICIOUS_THRESHOLD || 31);
const HIGH_THRESHOLD = () => Number(process.env.AI_RISK_TAMPERED_THRESHOLD || 71);

function isConfigured() {
  return Boolean(process.env.AI_API_KEY);
}

function unavailableReason() {
  if (!process.env.AI_API_KEY) return 'AI_API_KEY is not configured.';
  return 'AI provider request failed.';
}

const CHECK_NAMES = [
  'Font consistency',
  'Font size consistency',
  'Text alignment',
  'Layout structure',
  'Logo integrity',
  'Signature region',
  'Image manipulation',
  'Text modification',
  'Certificate number and date anomalies',
  'Document metadata',
  'Missing required fields',
  'Copy/paste artifacts',
];

const SYSTEM_PROMPT = `You are a document fraud analyst for academic certificates.
You will receive text extracted (OCR) from a real certificate document plus basic file metadata.
Evaluate ONLY what the evidence supports. If the extracted text is too poor to assess a check, mark that check as "insufficient" with a neutral note - never guess.
Respond with STRICT JSON only, no prose, matching:
{
  "riskScore": integer 0-100,
  "classification": "Likely Authentic" | "Suspicious" | "Likely Tampered",
  "checks": [ { "name": string, "status": "pass" | "warning" | "fail" | "insufficient", "note": string } ],
  "findings": [ string ]
}
Consider: font consistency, font size consistency, alignment, layout structure, logo integrity,
signature region, image manipulation, text modification, certificate number and date anomalies,
document metadata inconsistencies, missing required fields, copy/paste artifacts.
riskScore 0 means no evidence of manipulation; 100 means strong evidence of manipulation.`;

/**
 * Run a real AI analysis on the OCR text of a document.
 * Returns a structured result or throws AI_UNAVAILABLE.
 */
async function analyzeDocument({ ocrText, filePath, mimetype, certificateId }) {
  if (!isConfigured()) {
    const e = new Error('AI analysis is currently unavailable.');
    e.code = 'AI_UNAVAILABLE';
    throw e;
  }

  const base = (process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  let fileSize = 0;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch (_) {
    fileSize = 0;
  }

  const userContent = [
    `Certificate reference: ${certificateId || 'not assigned yet'}`,
    `File type: ${mimetype}`,
    `File size: ${fileSize} bytes`,
    '',
    'OCR text extracted from the document:',
    '---',
    (ocrText || '').slice(0, 12000),
    '---',
    '',
    `Assess these checks: ${CHECK_NAMES.join('; ')}.`,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const e = new Error('AI analysis is currently unavailable.');
      e.code = 'AI_UNAVAILABLE';
      e.detail = `Provider responded ${response.status}`;
      throw e;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      const e = new Error('AI analysis is currently unavailable.');
      e.code = 'AI_UNAVAILABLE';
      throw e;
    }

    const parsed = normalize(JSON.parse(content), payload, model);
    return parsed;
  } catch (err) {
    if (err.code === 'AI_UNAVAILABLE') throw err;
    const e = new Error('AI analysis is currently unavailable.');
    e.code = 'AI_UNAVAILABLE';
    e.cause = err;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize provider output into the canonical structure with validated ranges. */
function normalize(raw, payload, model) {
  let riskScore = Number(raw.riskScore);
  if (!Number.isFinite(riskScore)) riskScore = 0;
  riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));

  const low = LOW_THRESHOLD();
  const high = HIGH_THRESHOLD();
  let classification = raw.classification;
  if (!['Likely Authentic', 'Suspicious', 'Likely Tampered'].includes(classification)) {
    classification = riskScore < low ? 'Likely Authentic' : riskScore < high ? 'Suspicious' : 'Likely Tampered';
  }

  const checks = Array.isArray(raw.checks)
    ? raw.checks
        .filter((c) => c && typeof c.name === 'string')
        .slice(0, 30)
        .map((c) => ({
          name: c.name,
          status: ['pass', 'warning', 'fail', 'insufficient'].includes(c.status) ? c.status : 'insufficient',
          note: typeof c.note === 'string' ? c.note.slice(0, 500) : '',
        }))
    : [];

  const findings = Array.isArray(raw.findings)
    ? raw.findings.filter((f) => typeof f === 'string').slice(0, 25).map((f) => f.slice(0, 500))
    : [];

  return {
    riskScore,
    classification,
    checks,
    findings,
    provider: 'openai-compatible',
    model: payload?.model || model,
  };
}

function classifyScore(riskScore) {
  const low = LOW_THRESHOLD();
  const high = HIGH_THRESHOLD();
  if (riskScore < low) return { band: 'low', label: 'Likely Authentic' };
  if (riskScore < high) return { band: 'medium', label: 'Suspicious' };
  return { band: 'high', label: 'Likely Tampered' };
}

/**
 * Real AI polish for the resume professional summary.
 *
 * The caller passes ONLY facts already stored on this platform (verified
 * certificates, degrees, institutions, marks). The model is explicitly
 * forbidden from inventing skills, experience or grades - it can only
 * rephrase what is in the facts. If the provider is not configured or the
 * call fails, the error surfaces as 'AI summary currently unavailable' and
 * the client falls back to the deterministic summary built from the same
 * facts. Never fabricates data.
 */
const RESUME_SYSTEM_PROMPT = `You are a professional resume writer.
You receive verified academic facts from a credential platform (real certificates
issued to a student, stored on-chain). Write a concise professional summary for
the top of a resume.
STRICT RULES:
- Use ONLY the facts provided. Do NOT invent skills, tools, work experience,
  projects, grades or dates that are not present in the facts.
- Do not copy punctuation errors from OCR-style raw marks text; quote marks as given.
- About 40-70 words, plain text, first person implicit (no "I").
Respond with STRICT JSON only, no prose, matching:
{ "summary": string }
If the facts are too sparse for a meaningful summary, respond {"summary": ""}.`;

async function generateResumeSummary({ facts }) {
  if (!isConfigured()) {
    const e = new Error('AI polish for the resume summary is currently unavailable.');
    e.code = 'AI_UNAVAILABLE';
    e.detail = 'AI_API_KEY is not configured.';
    throw e;
  }

  const base = (process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  const userContent = [
    'Verified academic facts for this student:',
    JSON.stringify(facts, null, 1),
    '',
    'Write the professional summary now.',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: RESUME_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const e = new Error('AI polish for the resume summary is currently unavailable.');
      e.code = 'AI_UNAVAILABLE';
      e.detail = `Provider responded ${response.status}`;
      throw e;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      const e = new Error('AI polish for the resume summary is currently unavailable.');
      e.code = 'AI_UNAVAILABLE';
      e.detail = 'Provider returned an empty response.';
      throw e;
    }

    const parsed = JSON.parse(content);
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 1200) : '';
    return { summary, provider: 'openai-compatible', model: payload?.model || model };
  } catch (err) {
    if (err.code === 'AI_UNAVAILABLE') throw err;
    const e = new Error('AI polish for the resume summary is currently unavailable.');
    e.code = 'AI_UNAVAILABLE';
    e.detail = err.message;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { analyzeDocument, isConfigured, unavailableReason, classifyScore, CHECK_NAMES, LOW_THRESHOLD, HIGH_THRESHOLD, generateResumeSummary, RESUME_SYSTEM_PROMPT };
