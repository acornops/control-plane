CREATE TABLE IF NOT EXISTS user_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_user_password_credentials_last_login
  ON user_password_credentials (last_login_at DESC);

CREATE TABLE IF NOT EXISTS user_email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_email_verification_tokens_user_email
  ON user_email_verification_tokens (user_id, email);

CREATE INDEX IF NOT EXISTS idx_user_email_verification_tokens_expires_at
  ON user_email_verification_tokens (expires_at);

CREATE TABLE IF NOT EXISTS user_password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_password_reset_tokens_user_email
  ON user_password_reset_tokens (user_id, email);

CREATE INDEX IF NOT EXISTS idx_user_password_reset_tokens_expires_at
  ON user_password_reset_tokens (expires_at);
