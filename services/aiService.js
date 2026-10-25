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
const { prepareDocumentImage } = require('./documentImage');

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
You receive the plain text extracted (OCR) from the document, basic file metadata,
AND - when an image is attached to this message - the scanned document image itself.

STRICT EVIDENCE RULES:
1. OCR routinely garbles document text - broken words, stray spaces, substituted characters,
   jagged table columns, truncated lines, missing letters. That is a property of OCR extraction,
   NOT evidence of tampering. Never cite OCR noise, misspellings or column jaggedness as findings.
2. If NO image is attached, visual checks - Font consistency, Font size consistency,
   Text alignment, Layout structure, Logo integrity, Signature region, Image manipulation,
   Copy/paste artifacts - cannot be judged from text. Return each of them with status
   "insufficient" and the note "Document image unavailable; cannot assess visual integrity."
   Never pass, warn or fail them.
3. When an image IS attached, assess those visual checks genuinely from what is visible:
   - Font/size consistency: do letterforms, weights and sizes match across one printed area?
   - Text alignment: do values sit consistently in their rows/columns versus the template?
   - Layout structure: does the composition match a plausible certificate/grade-sheet template?
   - Logo integrity: is an organisation logo/mark present, positioned plausibly, not distorted,
     overlaid, cropped-copied or missing where one is expected?
   - Signature region: does a plausible authority signature/stamp appear, or is the area blank?
   - Image manipulation: look for blurry patches, cloned rectangles, inconsistent compression
     grain or background, cropped borders, resampled regions, pasted-on text.
   - Copy/paste artifacts: duplicated value blocks or awkwardly filled table cells.
4. Honesty about resolution: true document scans are often ~500 px phone shots. Judge only
   what is visible at that resolution; garbled small print is a scan limitation, not tampering.
   If a specific visual check truly cannot be judged from the image quality, return it
   "insufficient" with an honest note - do NOT pass or fail it by default.
5. These checks are always judged from the text itself: Text modification,
   Certificate number and date anomalies, Document metadata, Missing required fields.
   Base them on the extracted content, not on how well it was extracted.

RISK SCORE RUBRIC:
- 0-15 "Likely Authentic": coherent certificate text/image containing the expected fields
  (title, holder name, institution, date, identifier, signature line) and no manipulation
  evidence. This is the NORMAL result for a genuine document, however noisy its OCR is.
- 16-30 "Likely Authentic": minor oddities (textual or low-stakes visual) with no concrete
  evidence of alteration.
- 31-70 "Suspicious": only when you can cite specific evidence of a problem - a required
  field genuinely absent, an impossible or malformed date, placeholder text (lorem ipsum,
  "John Doe", "TEST"), self-contradicting content, visible edit seams or cloned regions.
- 71-100 "Likely Tampered": only for strong, quotable evidence of deliberate alteration.
- NEVER assign Suspicious or Likely Tampered on OCR quality or low scan resolution alone.

Respond with STRICT JSON only, no prose, matching:
{
  "riskScore": integer 0-100,
  "classification": "Likely Authentic" | "Suspicious" | "Likely Tampered",
  "checks": [ { "name": string, "status": "pass" | "warning" | "fail" | "insufficient", "note": string } ],
  "findings": [ string ]
}
Return one check for each of: ${CHECK_NAMES.join('; ')}.
Every finding must quote the evidence it relies on (text fragment or what the image shows).
If you have no evidence of manipulation, return a riskScore of 0-15, classification
"Likely Authentic", and empty findings.`;

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

  const userText = [
    `Certificate reference: ${certificateId || 'not assigned yet'}`,
    `File type: ${mimetype}`,
    `File size: ${fileSize} bytes`,
    '',
    'OCR text extracted from the document:',
    '---',
    (ocrText || '').slice(0, 12000),
    '---',
  ].join('\n');

  // Vision input: attach a JPEG of the document (PDFs are rendered to page 1
  // bitmaps first). When preparation fails, userContent degrades to the
  // previous text-only message and the system prompt tells the model to mark
  // visual checks insufficient instead of guessing.
  const docImage = await prepareDocumentImage(filePath, mimetype).catch(() => null);
  const userTextWithImageNote = docImage
    ? `A JPEG rendering of the uploaded document is attached after this text. Assess the visual checks from it.\n\n${userText}`
    : userText;
  const userContent = docImage
    ? [
        { type: 'text', text: userTextWithImageNote },
        { type: 'image_url', image_url: { url: docImage.dataUri } },
      ]
    : userText;

  const callProviderOnce = async (modelName) => {
    const controller = new AbortController();
    // 45 s per attempt: leaves room for the 8 s backoff retry AND fallback
    // models inside the overall deadline below.
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
          model: modelName,
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
        e.model = modelName;
        e.detail = `${modelName}: provider responded ${response.status}`;
        if (response.status === 429) {
          e.detail = `${modelName}: provider rate limit (HTTP 429).`;
          e.transient = true;
        } else if (response.status >= 500) {
          e.detail = `${modelName}: provider server error (HTTP ${response.status}).`;
          e.transient = true;
        }
        throw e;
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        const e = new Error('AI analysis is currently unavailable.');
        e.code = 'AI_UNAVAILABLE';
        e.model = modelName;
        e.detail = `${modelName}: provider returned an empty response.`;
        throw e;
      }

      return normalize(JSON.parse(content), payload, modelName);
    } catch (err) {
      if (err.code === 'AI_UNAVAILABLE') throw err;
      const e = new Error('AI analysis is currently unavailable.');
      e.code = 'AI_UNAVAILABLE';
      e.model = modelName;
      e.cause = err;
      if (err.name === 'AbortError') {
        // Provider hung: transient, so the retry / fallback gets a real chance.
        e.detail = `${modelName}: provider request timed out after 45 s.`;
        e.transient = true;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  // Resilience against provider flakiness (the primary model periodically
  // returns 503 "high demand" / 429):
  //   - one 8 s backoff retry per transient failure, then
  //   - fall through to the next model in AI_MODEL_FALLBACKS (comma separated).
  // Gemini models reachable through this key (verified 2026-10-21):
  // gemini-flash-lite-latest ~2 s, gemini-3.5-flash-lite ~18 s, gemini-3.5-flash ~5 s.
  const chain = [model];
  for (const m of String(process.env.AI_MODEL_FALLBACKS || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.5-flash').split(',')) {
    const fallback = m.trim();
    if (fallback && fallback !== model && !chain.includes(fallback)) chain.push(fallback);
  }
  const deadline = Date.now() + 110000; // total cap so HTTP clients do not hang

  let lastError = null;
  for (let i = 0; i < chain.length; i += 1) {
    const modelName = chain[i];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (Date.now() > deadline) {
        const e = new Error('AI analysis is currently unavailable.');
        e.code = 'AI_UNAVAILABLE';
        e.detail = (lastError && lastError.detail) || 'Provider failed transiently; overall time budget exhausted.';
        e.attemptsMade = `${i} model(s) tried`;
        throw e;
      }
      try {
        return await callProviderOnce(modelName);
      } catch (err) {
        lastError = err;
        if (err.code === 'AI_UNAVAILABLE' && err.transient && attempt === 0 && Date.now() <= deadline) {
          await new Promise((r) => setTimeout(r, 8000));
          continue;
        }
        break; // non-transient or out of attempts -> next model
      }
    }
  }
  if (lastError) {
    lastError.detail = `${lastError.detail || 'AI provider failed.'} (${chain.length} model(s) tried, each with one retry)`;
    throw lastError;
  }
  const e = new Error('AI analysis is currently unavailable.');
  e.code = 'AI_UNAVAILABLE';
  e.detail = 'No AI model is configured.';
  throw e;
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
