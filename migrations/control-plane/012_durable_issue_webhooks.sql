ALTER TABLE target_issues
  ADD COLUMN IF NOT EXISTS lifecycle_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE webhook_history
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS will_retry BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS terminal_reason TEXT NULL;

CREATE TABLE IF NOT EXISTS webhook_outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  workspace_id TEXT NOT NULL,
  target_id TEXT NULL,
  target_type TEXT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedupe_key TEXT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_delivery_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES webhook_outbox_events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'retrying', 'paused', 'succeeded', 'failed', 'superseded', 'cancelled'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  terminal_reason TEXT NULL,
  snapshot_url TEXT NULL,
  snapshot_secret_ciphertext TEXT NULL,
  snapshot_secret_key_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_jobs_due
  ON webhook_delivery_jobs (status, next_attempt_at, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_jobs_subscription
  ON webhook_delivery_jobs (subscription_id, status);

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_events_subject
  ON webhook_outbox_events (subject_type, subject_id, occurred_at DESC);
