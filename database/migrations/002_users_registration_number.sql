ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_registration_number ON users(registration_number) WHERE registration_number IS NOT NULL;
