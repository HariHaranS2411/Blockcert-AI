# Deploying BlockCert AI to the cloud (stays online when your laptop is off)

The app ships as **one Docker image**: the Node.js server, an in-process Ganache
chain and the `CertificateRegistry` contract, deployed fresh at every container
start. The **database is external and persistent** (free cloud Postgres by Neon),
so users, institutions, certificates, revocations, verifications and AI analyses
survive redeploys — and the public URL keeps working with your laptop off.

Repository: `github.com/HariHaranS2411/Blockcert-AI`, branch `main`.
Render reads `render.yaml` from that branch and builds `Dockerfile`.

## What you need (all free)

1. **GitHub** — the repo above (already set up; deploy commits are on `main`).
2. **Render** — runs the container and gives you the public HTTPS URL.
3. **Neon** — persistent cloud Postgres for your data.
4. Your AI provider key — the same value as `AI_API_KEY` in your local `.env`.

## Do not use a Render free PostgreSQL

Render's own free Postgres **expires 30 days after creation** and is deleted,
with all its data, after a 14-day grace period, and it has no backups. That is
why the persistent database lives at Neon (free plan, no expiry) and is injected
as `DATABASE_URL`. See <https://render.com/docs/free>.

## Step 1 — create the Neon database

1. Sign in at <https://neon.com>, create a project (any region close to you).
2. Copy the **connection string**, which looks like
   `postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require`
   Keep the `?sslmode=require` part: the app and the copy tool both need TLS for
   a cloud database.

## Step 2 — create the Render service from the blueprint

1. Sign in at <https://render.com> → **New → Blueprint** → pick
   `HariHaranS2411/Blockcert-AI` (branch `main`) → **Apply**.
2. **Keep the service name `blockcert-ai-hari2411`.** `render.yaml` sets
   `BASE_URL=https://blockcert-ai-hari2411.onrender.com`, and QR codes printed on
   already-issued certificates point at that exact URL — reusing the name keeps
   every existing QR valid. If the name is taken and Render assigns a different
   one, edit `BASE_URL` in `render.yaml` to `https://<the-name-onrender.com>` and
   re-apply before the first build finishes.
3. Fill the values the blueprint marks `sync: false` (if the service already
exists from an earlier attempt, a blueprint apply does **not** re-ask for values
it already has — open **Environment** on the service and set/clear them there):
   - `DATABASE_URL` — the Neon connection string from step 1
   - `AI_API_KEY` — your provider key (never commit it; it lives only in Render)
   - `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` — the password is only used
     when the database has **no** admin yet, so after you copy your data (step 4)
     it is ignored and your existing logins stay as they are
   Everything else (JWT_SECRET, chain keys, contract address) is generated or set
   by the boot script and must **not** be configured by hand.

## Step 3 — what the first boot does (check the Render log)

`Dockerfile` runs `node scripts/cloud-boot.js`, which on every start:

1. starts a fresh in-process chain on port 7545 (chainId 1337),
2. compiles and deploys `CertificateRegistry` for this boot and wires the issuer
   wallet to the funded account,
3. applies the DB migrations (structure only, idempotent),
4. creates an ADMIN from the env — only when the database has no admin,
5. **re-aligns the persisted chain state with the fresh chain**: institution
   wallet addresses are pointed at this boot's issuer and every certificate whose
   on-chain record is missing is registered again (revocations re-applied;
   fingerprint conflicts are reported, never silently adopted),
6. starts the normal server on Render's port.

A healthy boot logs, in order:
`[cloud-boot] ephemeral chain up on :7545` → `CertificateRegistry deployed at 0x…`
→ `migration applied: …` → `institution wallet realignment: N row(s) updated` →
`[cloud-boot] chain resync: re-registered N, re-revoked N, conflicts 0, errors 0`.

## Step 4 — copy your existing data into the hosted database

Wait until the deployed app answers `GET /api/health` (its migrations create the
schema first), then run the copy tool **from your local checkout** — local data
is the source, the hosted database is the target:

```bash
# 1. put the Neon URL in a gitignored file (it never belongs in a shell history or a chat)
echo 'postgresql://…?sslmode=require' > .hosted-db-url

# 2. dry run: reports what would be copied, writes nothing
node scripts/copy-to-hosted.js --target-file .hosted-db-url

# 3. the real copy
node scripts/copy-to-hosted.js --target-file .hosted-db-url --apply
```

It copies `users` (bcrypt hashes, so **existing passwords keep working**),
`institutions`, `certificates` with their document fingerprints, `revocations`,
`verifications`, `ai_analyses`, `audit_logs` and `student_resume_profiles`:
primary keys are preserved so foreign keys stay valid, sequences are reset, and
every table's row count is verified afterwards. It is repeatable — re-running it
replaces the hosted data with your local data. `schema_migrations` is left to the
hosted app.

## Step 5 — keep it awake

`.github/workflows/keep-alive.yml` pings `/api/health` every 10 minutes, which
stops the free service from falling asleep. It targets
`https://blockcert-ai-hari2411.onrender.com` by default; set a repository secret
named `APP_URL` if your URL differs.

## Free-tier facts (checked against the providers' docs)

- **Render free web service**: sleeps after **15 minutes** without traffic, cold
  start about **1 minute**, 750 free instance-hours per workspace per month.
  Docker builds and Blueprint deploys from GitHub are supported.
- **Render free Postgres**: expires **30 days** after creation (+14-day grace,
  then deleted) — see the warning above.
- **Neon free**: 1 GB storage per project (20 GB per account), 100 compute-hours
  per project per month, no project expiry; compute suspends after **5 minutes**
  idle and resumes in well under a second.
- Container memory is about 512 MB, so `NODE_OPTIONS=--max-old-space-size=384`
  is preset in the Dockerfile (OCR peaks).

## Uploaded document files (read this before complaining about a missing PDF)

- Uploaded documents are **never served statically**; downloads go through
  authenticated endpoints that check ownership.
- The container filesystem is **ephemeral**: documents uploaded *after* deploy
  are lost when Render rebuilds or restarts the container (their certificate
  records, hashes and chain entries survive in the database).
- Verification of an **existing** certificate works regardless: by ID, by
  uploading the document again (the hash is recomputed and compared against the
  database *and* the re-registered on-chain record) and by QR scan.
- What needs the original stored file is (a) re-downloading the file of a
  certificate issued **before** the deploy from a dashboard, and (b) duplicate
  detection comparing a new upload against pre-deploy documents. To get those
  too, commit the files under `uploads/` and delete the `uploads` line from
  `.dockerignore` so the image ships them. **This repository is public**, so that
  publishes those documents to anyone — only do it if that is acceptable.

## Verification checklist

- `GET /api/health` → `database.connected`, `blockchain.connected`, `ai.configured`
- Log in as each role you copied over (existing password, admin / institution / student)
- Verify an existing certificate by ID — issuer matches, revocation state correct
- Issue a certificate on the live site, then open its QR verification page in a
  private window (logged out)
- Confirm the app still answers with your laptop shut down, and after a Render
  restart (the chain state bootstrap must report `errors 0` again)
