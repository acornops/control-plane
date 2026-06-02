CREATE TABLE IF NOT EXISTS user_federated_identities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email_at_link_time TEXT NOT NULL,
  email_verified BOOLEAN NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX IF NOT EXISTS idx_user_federated_identities_user_id
  ON user_federated_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_user_federated_identities_last_login
  ON user_federated_identities (last_login_at DESC);
