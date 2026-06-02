ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_plan_key_check;

CREATE TABLE IF NOT EXISTS workspace_quota_overrides (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  members INTEGER NULL CHECK (members IS NULL OR members > 0),
  kubernetes_clusters INTEGER NULL CHECK (kubernetes_clusters IS NULL OR kubernetes_clusters > 0),
  virtual_machines INTEGER NULL CHECK (virtual_machines IS NULL OR virtual_machines > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workspace_audit_events
  ADD COLUMN IF NOT EXISTS actor_token_id TEXT NULL;

ALTER TABLE workspace_audit_events
  DROP CONSTRAINT IF EXISTS workspace_audit_events_actor_type_check;

ALTER TABLE workspace_audit_events
  DROP CONSTRAINT IF EXISTS workspace_audit_events_user_actor_check;

ALTER TABLE workspace_audit_events
  ADD CONSTRAINT workspace_audit_events_actor_type_check
    CHECK (actor_type IN ('user', 'system', 'admin_token'));

ALTER TABLE workspace_audit_events
  ADD CONSTRAINT workspace_audit_events_user_actor_check
    CHECK (
      (actor_type = 'system' AND actor_user_id IS NULL AND actor_token_id IS NULL)
      OR (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_token_id IS NULL)
      OR (actor_type = 'admin_token' AND actor_user_id IS NULL AND actor_token_id IS NOT NULL)
    );

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id TEXT PRIMARY KEY,
  admin_token_id TEXT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  workspace_id TEXT NULL,
  target_type TEXT NULL,
  target_id TEXT NULL,
  subject_type TEXT NULL,
  subject_id TEXT NULL,
  reason TEXT NULL,
  request_id TEXT NOT NULL,
  source_ip_hash TEXT NULL,
  user_agent TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_audit_events_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS admin_audit_events_occurred_at_idx
  ON admin_audit_events (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_workspace_idx
  ON admin_audit_events (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_token_idx
  ON admin_audit_events (admin_token_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_action_idx
  ON admin_audit_events (action, occurred_at DESC, id DESC);
