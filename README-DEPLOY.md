# Deploying BlockCert AI to the cloud (stays online when your laptop is off)

The app ships as **one Docker image**: Node.js server + an in-process Ganache
chain + the smart contract, deployed fresh at every container start. The
**database is external and persistent** (free cloud Postgres by Neon), so users,
certificates, verifications and AI analyses survive restarts. The QR codes point
at the public hosted URL.

## What you need (all free)

1. A **GitHub** account — the repo + an automatic keep-alive ping live there.
2. A **Render** account — runs the container 24/7 (free plan).
3. A **Neon** account — persistent cloud Postgres (free tier, no expiry).
4. Your AI provider API key (the same one already in your local `.env`).

## Step-by-step

1. **Push the repo to GitHub** (I do this once the repo is created).
2. **Neon**: create a project → copy the connection string
   `postgresql://user:pass@ep-....neon.tech/dbname?sslmode=require`
3. **Render**: New → Blueprint → select the repo. Render reads `render.yaml`
   and asks you to fill the `sync: false` values:
   - `DATABASE_URL` — the Neon connection string
   - `AI_API_KEY` — your AI provider key
   - `BASE_URL` — `https://<your-service>.onrender.com` (the final public URL)
   - `ADMIN_PASSWORD` — passphrase for the bootstrapped admin
4. First deploy builds the image and boots. The boot script:
   - starts a fresh ephemeral chain (chainId 1337),
   - deploys `CertificateRegistry` for THIS boot,
   - applies DB migrations (structure only),
   - creates the admin from `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`
     **only when the database has no admin yet** (idempotent).
5. **Verify** (checklist below) and use it.

## Honest limitations of the free tier

- **Files are ephemeral**: uploaded document files live in the container's
  filesystem and are lost when Render redeploys/restarts the container. The
  certificate RECORDS survive (they are in Postgres); duplicate detection and
  document downloads degrade gracefully for older rows ("document file is no
  longer available"). Anything issued while the container is up works fully.
- **Sleep**: on the free plan the web service sleeps after ~15 min without
  traffic; the first visitor then waits ~50 s. The scheduled GitHub Actions
  ping (`.github/workflows/keep-alive.yml`) keeps it warm every 10 minutes.
- **Ganache is ephemeral by design**: the contract is re-deployed each boot and
  issuance re-registers certificates in real time. Verification reads the chain
  as usual — the DB remains the source of truth.
- Neon (free tier) suspends its Postgres compute after ~5 min idle; the first
  query after a pause may add ~1–2 s latency.
- Free container memory is ~512 MB; OCR-heavy documents occasionally need a
  few extra seconds (`NODE_OPTIONS=--max-old-space-size=384` is preconfigured).

## Verification checklist (I run this after the first deploy)

- `GET /api/health` → database + blockchain + AI all connected
- Login as admin / institution / student (dashboards open per role)
- Institution: OCR extract → issue certificate → QR code points at BASE_URL
- Verification by ID, by document upload (hash + AI), by QR scan
- Open the QR verification page in a browser WITHOUT being logged in
