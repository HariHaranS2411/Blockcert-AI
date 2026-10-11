-- ---------------------------------------------------------------
-- BlockCert AI initial schema (structure only, ZERO business data)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS institutions (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  registration_number TEXT,
  official_email      TEXT NOT NULL UNIQUE,
  address             TEXT,
  website             TEXT,
  wallet_address      TEXT,
  verification_status TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (verification_status IN ('PENDING','APPROVED','REJECTED','SUSPENDED')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('STUDENT','INSTITUTION','EMPLOYER','ADMIN')),
  institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL,
  registration_number TEXT UNIQUE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_institution ON users(institution_id);

CREATE TABLE IF NOT EXISTS certificates (
  id                  SERIAL PRIMARY KEY,
  certificate_id      TEXT NOT NULL UNIQUE,
  student_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  institution_id      INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  student_name        TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  degree              TEXT NOT NULL,
  department          TEXT,
  certificate_type    TEXT NOT NULL,
  academic_year       TEXT,
  marks               TEXT,
  issue_date          DATE NOT NULL,
  expiry_date         DATE,
  document_path       TEXT NOT NULL,
  document_filename   TEXT NOT NULL,
  document_mime       TEXT NOT NULL,
  document_size       INTEGER NOT NULL,
  document_hash       TEXT NOT NULL UNIQUE,
  ocr_text            TEXT,
  ocr_status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (ocr_status IN ('pending','completed','failed','insufficient')),
  status              TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','REVOKED','SUSPENDED')),
  blockchain_tx_hash  TEXT,
  blockchain_record_id TEXT,
  block_number        BIGINT,
  blockchain_status   TEXT NOT NULL DEFAULT 'pending'
                      CHECK (blockchain_status IN ('pending','registered','failed','not_configured')),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_student_institution_degree UNIQUE (student_name, registration_number, institution_id, degree, issue_date)
);
CREATE INDEX IF NOT EXISTS idx_certificates_student ON certificates(student_id);
CREATE INDEX IF NOT EXISTS idx_certificates_institution ON certificates(institution_id);
CREATE INDEX IF NOT EXISTS idx_certificates_status ON certificates(status);
CREATE INDEX IF NOT EXISTS idx_certificates_type ON certificates(certificate_type);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id              SERIAL PRIMARY KEY,
  certificate_id  INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  document_path   TEXT,
  risk_score      INTEGER CHECK (risk_score BETWEEN 0 AND 100),
  classification  TEXT,
  findings        JSONB,
  provider        TEXT,
  model           TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'completed'
                  CHECK (analysis_status IN ('completed','unavailable')),
  unavailable_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_certificate ON ai_analyses(certificate_id);

CREATE TABLE IF NOT EXISTS verifications (
  id                    SERIAL PRIMARY KEY,
  certificate_id        INTEGER REFERENCES certificates(id) ON DELETE SET NULL,
  certificate_ref       TEXT NOT NULL,
  verifier_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verification_method   TEXT NOT NULL
                        CHECK (verification_method IN ('CERTIFICATE_ID','UPLOAD','QR','BULK')),
  uploaded_document_hash TEXT,
  blockchain_hash       TEXT,
  blockchain_status     TEXT,
  hash_match            BOOLEAN,
  issuer_verified       BOOLEAN,
  revocation_status     TEXT,
  ai_result             TEXT,
  ai_risk_score         INTEGER,
  final_result          TEXT NOT NULL
                        CHECK (final_result IN ('VERIFIED','SUSPICIOUS','TAMPERED','REVOKED','NOT_FOUND')),
  details               JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verifications_certificate ON verifications(certificate_id);
CREATE INDEX IF NOT EXISTS idx_verifications_ref ON verifications(certificate_ref);
CREATE INDEX IF NOT EXISTS idx_verifications_verifier ON verifications(verifier_id);
CREATE INDEX IF NOT EXISTS idx_verifications_created ON verifications(created_at);

CREATE TABLE IF NOT EXISTS revocations (
  id                SERIAL PRIMARY KEY,
  certificate_id    INTEGER NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  reason            TEXT NOT NULL,
  revoked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  blockchain_tx_hash TEXT,
  blockchain_status TEXT,
  revoked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revocations_certificate ON revocations(certificate_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         SERIAL PRIMARY KEY,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_ref TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);

-- Explicit admin setup tokens: created only through the real setup flow,
-- never seeded. Consumed on first use.
CREATE TABLE IF NOT EXISTS admin_setup_tokens (
  id          SERIAL PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
