# BlockCert AI

**Trust the Certificate. Verify the Proof.**

BlockCert AI is an AI-powered blockchain certificate verification and fraud detection
platform for academic credentials. It combines intelligent document-risk assessment with
blockchain-backed verification.

> **AI provides a document-risk assessment. Blockchain verification confirms whether the
> document matches the official issuer record. AI results are not absolute proof of
> authenticity.**

**Core principle:** AI detects suspicious document manipulation. Blockchain verifies the
official record.

- **Blockchain** handles the immutable registration, cryptographic fingerprint, issuer
  identity, timestamp and revocation. It is the authoritative check.
- **AI** handles visual anomaly detection and fraud-risk assistance. It is a supporting
  signal only.

This is a university credential platform, not a crypto product: no wallets, tokens,
coins, NFTs or trading features.

---

## Master rule: real data only

There is no demo mode, no seed data and no fixtures in the application. Every value the
UI shows comes from a real operation:

| Data | Source |
| --- | --- |
| Users, institutions, certificates | Real PostgreSQL rows written by real registrations/issuances |
| SHA-256 fingerprints | `crypto` hash of the actual uploaded bytes |
| Transaction hashes, block numbers, issuer address | Real `ethers.js` calls to the deployed contract |
| OCR fields | Tesseract.js / pdf-parse on the actual file |
| AI risk scores | Real AI provider call (only when `AI_API_KEY` is set) |
| Statistics, charts, counts | Real `COUNT(*)` queries (zeros are valid) |
| Verification history, audit logs | Rows created only when a real event happens |

If a dependency is missing, the app shows an honest state and never a substitute:

- Blockchain down → *"Blockchain verification is currently unavailable."*
- AI not configured or failing → *"AI analysis is currently unavailable."* (no fallback score, ever)
- OCR failure → *"Unable to extract sufficient text from this document."*
- Database down → *"Database connection unavailable."*

---

## Features

- **Public verification** (no login) by certificate ID, document upload or QR scan
- **Certificate issuance** with OCR review: upload → human-reviewed extraction → SHA-256 →
  on-chain registration → QR code → ACTIVE
- **Bulk issuance** from CSV with per-row real results and per-row errors
- **Revocation** with a confirmation dialog, real on-chain revocation transaction, reason
  and audit log (records are never deleted)
- **AI fraud detection**: font, layout, signature, metadata and anomaly checks with a
  transparent 0–100 risk score and per-check ✓ / ⚠ / ✕ results
- **Student dashboard**: own credentials only, digital credential profile, share links
- **Employer portal**: ID / upload / QR / bulk CSV verification with summary counts and
  CSV + printable reports
- **Admin dashboard**: real system counts, institution approval, user management, audit
  logs, system health
- **Verification history** and **certificate details** with collapsible *View Technical Details*
- **Roles**: Student, Institution, Employer, Admin — enforced server-side

Certificate types: Degree, Diploma, Internship, Course, Workshop, Hackathon, Sports,
NSS/NCC, Training, Skill, Academic Transcript.

---

## Architecture

```
blockcert-ai/
  server.js               Express app: security, static frontend, API routes
  package.json
  .env.example
  config/
    database.js           pg pool, transactions, honest unavailability errors
    blockchain.js         ethers provider/wallet/contract, health probe
  contracts/
    CertificateRegistry.sol   on-chain registry (hash, issuer, timestamp, revoked)
  models/
    databaseSchema.js     schema DDL (structure only, zero business rows)
    blockchainSchema.js   contract ABI
  database/
    migrate.js            migration runner (npm run db:migrate)
  routes/                 auth, institution, certificate, verification, student,
                          employer, admin, misc (ai/ocr/qr), dashboard
  controllers/            one per route file
  middleware/             authMiddleware, roleMiddleware, uploadMiddleware, errorMiddleware
  services/               hashService, blockchainService, aiService, ocrService,
                          qrService, verificationService, certificateService
  utils/                  validation, fileUtils, cryptoUtils
  scripts/                deploy-contract.js, create-admin.js
  public/                 HTML pages, css/, js/, partials/
  uploads/                stored documents (generated filenames, never served statically)
  test/                   e2e.js (real end-to-end test), start-pg.js (test DB support)
```

**Data-integrity flow:**

```
Document → SHA-256 → Blockchain → Verification
```

1. Institution uploads the real document (MIME/extension/size validated).
2. OCR extracts fields; a human corrects and confirms every value — nothing is auto-approved.
3. SHA-256 is computed from the actual file bytes.
4. A unique `CERT-YYYY-XXXXXX` ID is allocated from real database state (DB-unique constraint).
5. Duplicate checks run: certificate ID, document hash, student/credential combination.
6. The record is saved with `blockchain_status = pending`.
7. The server submits the real `issueCertificate` transaction, persists the tx hash, waits
   for the receipt and stores the real block number.
8. A QR code embedding only the public verification URL is generated.
9. Status becomes ACTIVE. A periodic reconciliation job finalises pending rows and adopts
   on-chain records when the chain succeeded but the DB update failed — but only when the
   fingerprint matches.

At verification time the app does **not** trust the database alone: it reads the
authoritative on-chain record, compares the uploaded document's SHA-256 with the chain
fingerprint, checks issuer approval and revocation, optionally runs AI, then decides:

| Condition | Result |
| --- | --- |
| No certificate record | `NOT FOUND` |
| Revoked (DB or chain) | `REVOKED` |
| Uploaded hash ≠ on-chain hash | `TAMPERED` |
| Chain unavailable/missing, issuer unapproved, or AI risk ≥ threshold | `SUSPICIOUS` (needs review) |
| Otherwise | `VERIFIED` |

If only an ID or QR is used (no document uploaded), the result states *"The certificate
record and blockchain registration were found."* — it never claims a physical file was
inspected.

### What is on-chain vs off-chain

**On-chain only:** SHA-256 fingerprint, issuer address, timestamp, revoked flag.
**Never on-chain:** PDFs, names, emails, or any personal data.

**Off-chain:** documents, student records, OCR output, AI analyses, verification history,
audit logs.

---

## Installation

### 1. Requirements

- Node.js ≥ 20
- PostgreSQL 14+ (or a Supabase PostgreSQL connection string)
- An EVM dev chain — Ganache is included as a dev dependency

### 2. Install packages

```bash
npm install
```

### 3. Environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
PORT=5000
BASE_URL=http://localhost:5000
DATABASE_URL=postgres://user:password@localhost:5432/blockcert
JWT_SECRET=            # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
BLOCKCHAIN_RPC_URL=http://127.0.0.1:7545
BLOCKCHAIN_PRIVATE_KEY=  # server-side issuer key; never exposed to the frontend
CONTRACT_ADDRESS=        # printed by npm run contract:deploy
AI_API_KEY=              # optional; without it AI reports "currently unavailable"
AI_API_BASE=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
UPLOAD_DIR=uploads
MAX_UPLOAD_MB=10
```

No `DEMO_MODE`. Secrets live only in `.env` (git-ignored).

### 4. Database schema (structure only, no seed rows)

```bash
npm run db:migrate
```

### 5. Local chain + contract deployment

```bash
# terminal A — local EVM chain (Ganache on :7545)
npm run chain

# terminal B — compile & deploy CertificateRegistry.sol
npm run contract:deploy
# → prints CONTRACT_ADDRESS=0x... — copy it into .env, then restart the server
```

### 6. Create the first admin (explicit setup — admins are never seeded)

```bash
node scripts/create-admin.js "Your Name" admin@yourschool.edu "Str0ngPass!"
```

### 7. Start

```bash
npm start          # or: npm run dev (auto-restart)
# → http://localhost:5000
```

### AI setup (optional)

Set `AI_API_KEY` (any OpenAI-compatible chat-completions endpoint via `AI_API_BASE`).
Without it, every AI path stores `analysis_status = unavailable` and shows
*"AI analysis is currently unavailable."* — no score is ever invented.

Risk thresholds (0–100) are configurable:

- `AI_RISK_SUSPICIOUS_THRESHOLD` (default 31) — 0–30 Likely Authentic, 31–70 Suspicious
- `AI_RISK_TAMPERED_THRESHOLD` (default 71) — 71–100 Likely Tampered

---

## API

| Method | Route | Auth |
| --- | --- | --- |
| POST | `/api/auth/register` | public |
| POST | `/api/auth/login` | public |
| GET | `/api/auth/me` | any user |
| POST | `/api/auth/login` … | rate-limited |
| GET/PUT | `/api/institutions/:id` | owner/admin |
| POST | `/api/certificates` | institution |
| GET | `/api/certificates` | institution/admin |
| GET | `/api/certificates/:id`, `/:id/download` | owner/admin |
| POST | `/api/certificates/bulk` | institution |
| POST | `/api/certificates/:id/revoke` | owning institution/admin |
| POST | `/api/verification/id`, `/upload`, `/qr` | public (rate-limited) |
| POST | `/api/verification/bulk` | logged-in |
| GET | `/api/verification/:id`, `/api/verification/history` | logged-in (scoped) |
| POST | `/api/ai/analyze` | logged-in, rate-limited |
| GET | `/api/ai/:certificateId` | institution/admin/employer |
| POST | `/api/ocr/extract` | institution/admin |
| GET | `/api/qr/:certificateId` | public |
| GET | `/api/students/me/certificates`, `/me/credentials`, `/me/history` | student (own only) |
| GET | `/api/students/:id/public-profile` | public (public-safe fields only) |
| GET | `/api/employer/history`, `/bulk-template` | employer/admin |
| GET | `/api/admin/*` | admin |
| GET | `/api/dashboard`, `/api/dashboard/public`, `/api/health` | scoped / public |

Every response uses `{ "success": boolean, "message": string, "data"?: ... }`. Errors
never expose stack traces, secrets or internal paths.

---

## Security

- **Passwords**: bcrypt (cost 12). Login returns one generic error for unknown email and
  wrong password.
- **Sessions**: JWT (12 h), sent as `Authorization: Bearer`.
- **Authorization**: role **and** ownership checks on every protected route — a student
  cannot read another student's certificate by changing an ID; an institution cannot
  revoke another institution's certificate.
- **Uploads**: MIME + extension + size validated, generated filenames, traversal-proof
  path resolution, files served only through authenticated ownership-checked endpoints
  (never statically).
- **Rate limits**: global API limiter plus dedicated limits on `/api/auth/*`,
  `/api/verification/*`, `/api/ai/*` and upload routes.
- **Headers**: helmet with a strict CSP; configured CORS (`CORS_ORIGIN`).
- **Validation**: express-validator chains on every input; SQL is parameterized everywhere.
- **Secrets**: environment variables only; the chain private key never reaches the browser.
- **Audit**: real events only (registration, login, issuance, chain registration,
  verification, revocation, bulk operations, admin changes).
- **Revocation** flips a flag on-chain and marks the row REVOKED — history is never deleted.

---

## Testing

`test/e2e.js` drives the real stack end to end — real registrations, a real PDF upload,
a real SHA-256, a real on-chain registration, a real tamper (modified PDF → real hash
mismatch → `TAMPERED`), a real revocation → `REVOKED`, role isolation checks, honest
AI-unavailable responses and admin counts.

```bash
# with PostgreSQL + Ganache running and the app started:
node test/e2e.js
```

The last full run: **158 passed, 0 failed.**

---

## Honest empty states

A fresh install shows Users 0, Institutions 0, Certificates 0, Verifications 0,
Revoked 0 and looks polished:

- "No certificates have been issued yet."
- "No verification activity yet."
- "No users have registered yet."
- "No certificates have been issued to your account yet."
- "AI analysis has not been performed."
