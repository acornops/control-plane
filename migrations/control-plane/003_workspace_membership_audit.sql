ALTER TABLE workspace_memberships
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'internal';

ALTER TABLE workspace_memberships
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE workspace_memberships
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS workspace_membership_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_role TEXT NULL,
  next_role TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_membership_audit_workspace_created
  ON workspace_membership_audit (workspace_id, created_at DESC);
