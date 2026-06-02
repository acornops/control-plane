CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ NULL,
  email_verification_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan_key TEXT NOT NULL DEFAULT 'default' CHECK (plan_key IN ('default')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS role_templates (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('system', 'custom')),
  capabilities JSONB NOT NULL,
  protected BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded', 'unknown')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT targets_workspace_id_id_unique UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS kubernetes_target_settings (
  target_id TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  namespace_include JSONB NOT NULL DEFAULT '[]'::jsonb,
  namespace_exclude JSONB NOT NULL DEFAULT '[]'::jsonb,
  write_confirmation_required_override BOOLEAN NULL
);

CREATE TABLE IF NOT EXISTS target_agent_registrations (
  target_id TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  agent_key_hash TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  last_seen_at TIMESTAMPTZ NULL,
  last_heartbeat_at TIMESTAMPTZ NULL,
  last_connection_id TEXT NULL,
  last_agent_version TEXT NULL,
  capabilities JSONB NULL
);

CREATE TABLE IF NOT EXISTS target_snapshots (
  target_id TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  snapshot_ts TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS target_inventory_items (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_ts TIMESTAMPTZ NOT NULL,
  item_id TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_kind TEXT NULL,
  scope_name TEXT NULL,
  name TEXT NOT NULL,
  status TEXT NULL,
  location TEXT NULL,
  needs_attention BOOLEAN NOT NULL,
  sort_key TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  item JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, item_id)
);

CREATE TABLE IF NOT EXISTS target_findings (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_ts TIMESTAMPTZ NOT NULL,
  finding_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  severity_rank INTEGER NOT NULL,
  scope_kind TEXT NULL,
  scope_name TEXT NULL,
  object_kind TEXT NULL,
  object_name TEXT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  reason TEXT NULL,
  finding_ts TIMESTAMPTZ NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, finding_id)
);

CREATE TABLE IF NOT EXISTS target_snapshot_summaries (
  target_id TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_ts TIMESTAMPTZ NOT NULL,
  inventory_count INTEGER NOT NULL,
  finding_count INTEGER NOT NULL,
  critical_finding_count INTEGER NOT NULL,
  summary JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS target_tool_overrides (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, tool_name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  usage JSONB NULL,
  assistant_message JSONB NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  secret_ciphertext TEXT NOT NULL,
  secret_key_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_history (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NULL REFERENCES targets(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER NULL,
  error TEXT NULL,
  duration_ms INTEGER NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE target_agent_registrations
  ADD CONSTRAINT fk_target_agent_registrations_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE target_snapshots
  ADD CONSTRAINT fk_target_snapshots_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE target_inventory_items
  ADD CONSTRAINT fk_target_inventory_items_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE target_findings
  ADD CONSTRAINT fk_target_findings_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE target_snapshot_summaries
  ADD CONSTRAINT fk_target_snapshot_summaries_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE sessions
  ADD CONSTRAINT fk_sessions_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE runs
  ADD CONSTRAINT fk_runs_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE webhook_subscriptions
  ADD CONSTRAINT fk_webhook_subscriptions_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE webhook_history
  ADD CONSTRAINT fk_webhook_history_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user_id
  ON workspace_memberships (user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_role
  ON workspace_memberships (workspace_id, role);

CREATE INDEX IF NOT EXISTS idx_targets_workspace_type
  ON targets (workspace_id, target_type);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_target
  ON sessions (workspace_id, target_id);

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_runs_session_id
  ON runs (session_id);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id_seq
  ON run_events (run_id, seq);

CREATE INDEX IF NOT EXISTS idx_target_tool_overrides_target
  ON target_tool_overrides (target_id);

CREATE INDEX IF NOT EXISTS idx_inventory_items_target_sort
  ON target_inventory_items (target_id, sort_key);

CREATE INDEX IF NOT EXISTS idx_inventory_items_target_category_sort
  ON target_inventory_items (target_id, category, sort_key);

CREATE INDEX IF NOT EXISTS idx_inventory_items_target_kind_sort
  ON target_inventory_items (target_id, kind, sort_key);

CREATE INDEX IF NOT EXISTS idx_inventory_items_target_scope_sort
  ON target_inventory_items (target_id, scope_name, sort_key);

CREATE INDEX IF NOT EXISTS idx_inventory_items_target_attention_sort
  ON target_inventory_items (target_id, needs_attention, sort_key);

CREATE INDEX IF NOT EXISTS idx_inventory_items_search_trgm
  ON target_inventory_items USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_target_findings_target_order
  ON target_findings (target_id, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX IF NOT EXISTS idx_target_findings_workspace_order
  ON target_findings (workspace_id, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX IF NOT EXISTS idx_target_findings_workspace_target_order
  ON target_findings (workspace_id, target_id, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX IF NOT EXISTS idx_target_findings_workspace_scope_order
  ON target_findings (workspace_id, scope_name, severity_rank, finding_ts DESC, finding_id);

CREATE INDEX IF NOT EXISTS idx_target_findings_search_trgm
  ON target_findings USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_snapshot_summaries_workspace_target
  ON target_snapshot_summaries (workspace_id, target_id);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_workspace_enabled
  ON webhook_subscriptions (workspace_id, enabled);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_workspace_target
  ON webhook_subscriptions (workspace_id, target_id);

CREATE INDEX IF NOT EXISTS idx_webhook_history_subscription_sent_at
  ON webhook_history (subscription_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_history_workspace_sent_at
  ON webhook_history (workspace_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_history_event_id
  ON webhook_history (event_id);
