CREATE TABLE IF NOT EXISTS mcp_secret_cleanup_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('member_removal', 'workspace_delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_secret_cleanup_jobs_due
  ON mcp_secret_cleanup_jobs (status, next_attempt_at, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_secret_cleanup_jobs_scope
  ON mcp_secret_cleanup_jobs (workspace_id, COALESCE(user_id, ''), reason);
