CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ NULL,
  email_verification_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL
);

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

CREATE TABLE IF NOT EXISTS external_integration_link_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  integration_client_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  client_display_name TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  external_display_name TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  invalidated_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS external_integration_user_links (
  id TEXT PRIMARY KEY,
  integration_client_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  client_display_name TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  external_display_name TEXT NULL,
  acornops_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  UNIQUE (integration_client_id, provider, external_user_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan_key TEXT NOT NULL DEFAULT 'default',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_quota_overrides (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  members INTEGER NULL CHECK (members IS NULL OR members > 0),
  kubernetes_clusters INTEGER NULL CHECK (kubernetes_clusters IS NULL OR kubernetes_clusters > 0),
  virtual_machines INTEGER NULL CHECK (virtual_machines IS NULL OR virtual_machines > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  default_provider TEXT NOT NULL CHECK (default_provider IN ('openai', 'anthropic', 'gemini')),
  default_model TEXT NOT NULL,
  reasoning_summary_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed')),
  reasoning_effort TEXT NOT NULL DEFAULT 'low'
    CHECK (reasoning_effort IN ('off', 'low', 'medium', 'high')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'internal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

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

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  accepted_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL
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
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
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

CREATE TABLE IF NOT EXISTS target_issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  fingerprint TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'recovering', 'resolved')),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  severity_rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  scope_kind TEXT NULL,
  scope_name TEXT NULL,
  object_kind TEXT NULL,
  object_name TEXT NULL,
  reason TEXT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_observed_snapshot_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  clean_snapshot_count INTEGER NOT NULL DEFAULT 0,
  latest_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS target_issue_observations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES target_issues(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  snapshot_ts TIMESTAMPTZ NOT NULL,
  finding_id TEXT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  reason TEXT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS target_metric_history (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  sample_ts TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, sample_ts)
);

CREATE TABLE IF NOT EXISTS target_tool_overrides (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, tool_name)
);

CREATE TABLE IF NOT EXISTS target_tool_settings (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, tool_id)
);

CREATE TABLE IF NOT EXISTS target_insights_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  body_markdown TEXT NOT NULL,
  frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_summary TEXT NOT NULL DEFAULT '',
  observation_count INTEGER NOT NULL DEFAULT 0,
  confidence NUMERIC(4, 3) NOT NULL DEFAULT 0,
  first_observed_at TIMESTAMPTZ NULL,
  last_observed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT target_insights_entries_status_check
    CHECK (status IN ('active', 'pending', 'archived')),
  CONSTRAINT target_insights_entries_target_type_check
    CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  CONSTRAINT target_insights_entries_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT target_insights_entries_observation_count_check
    CHECK (observation_count >= 0),
  CONSTRAINT target_insights_entries_frontmatter_object_check
    CHECK (jsonb_typeof(frontmatter) = 'object'),
  CONSTRAINT target_insights_entries_signals_object_check
    CHECK (jsonb_typeof(signals) = 'object'),
  CONSTRAINT target_insights_entries_scope_object_check
    CHECK (jsonb_typeof(scope) = 'object')
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  deleted_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS target_insights_checkpoint_jobs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  retry_after TIMESTAMPTZ NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT target_insights_checkpoint_jobs_status_check
    CHECK (status IN ('queued', 'processing', 'applied', 'noop', 'skipped', 'failed')),
  CONSTRAINT target_insights_checkpoint_jobs_target_type_check
    CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  CONSTRAINT target_insights_checkpoint_jobs_attempts_check
    CHECK (attempts >= 0),
  PRIMARY KEY (workspace_id, target_id, session_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  metadata JSONB NULL,
  client_message_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT fk_messages_session
    FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  llm_provider TEXT NOT NULL DEFAULT 'openai' CHECK (llm_provider IN ('openai', 'anthropic', 'gemini')),
  llm_model TEXT NOT NULL DEFAULT 'gpt-5.5',
  llm_reasoning_summary_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (llm_reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed')),
  llm_reasoning_effort TEXT NOT NULL DEFAULT 'low'
    CHECK (llm_reasoning_effort IN ('off', 'low', 'medium', 'high')),
  tool_access_mode TEXT NOT NULL DEFAULT 'read_only',
  status TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  usage JSONB NULL,
  assistant_message JSONB NULL,
  CONSTRAINT fk_runs_session
    FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (run_id, seq),
  CONSTRAINT fk_run_events_run
    FOREIGN KEY (run_id)
    REFERENCES runs(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_tool_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  execution_status TEXT NOT NULL DEFAULT 'not_started',
  execution_started_at TIMESTAMPTZ NULL,
  execution_finished_at TIMESTAMPTZ NULL,
  tool_result JSONB NULL,
  tool_result_is_error BOOLEAN NULL,
  requested_by TEXT NULL,
  decided_by TEXT NULL,
  decision TEXT NULL,
  summary TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS run_continuations (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES run_tool_approvals(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_activity_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  session_id TEXT NOT NULL,
  run_id TEXT NULL,
  message_id TEXT NULL,
  approval_id TEXT NULL,
  type TEXT NOT NULL CHECK (
    type IN (
      'message.created',
      'run.created',
      'run.status_changed',
      'assistant_message.committed',
      'approval.requested',
      'approval.decided',
      'approval.expired',
      'session.deleted'
    )
  ),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_chat_activity_events_workspace_target
    FOREIGN KEY (workspace_id, target_id)
    REFERENCES targets(workspace_id, id)
    ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS workspace_audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  category TEXT NOT NULL,
  event_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_user_id TEXT NULL,
  actor_token_id TEXT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NULL,
  object_name TEXT NULL,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_audit_events_category_check
    CHECK (category IN ('membership', 'workspace', 'target', 'session', 'run', 'approval', 'mcp', 'tool', 'insights')),
  CONSTRAINT workspace_audit_events_operation_check
    CHECK (operation IN ('read', 'write')),
  CONSTRAINT workspace_audit_events_actor_type_check
    CHECK (actor_type IN ('user', 'system', 'admin_token')),
  CONSTRAINT workspace_audit_events_user_actor_check
    CHECK (
      (actor_type = 'system' AND actor_user_id IS NULL AND actor_token_id IS NULL)
      OR (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_token_id IS NULL)
      OR (actor_type = 'admin_token' AND actor_user_id IS NULL AND actor_token_id IS NOT NULL)
    ),
  CONSTRAINT workspace_audit_events_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS account_audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  event_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_token_id TEXT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NULL,
  object_name TEXT NULL,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT account_audit_events_operation_check
    CHECK (operation IN ('read', 'write')),
  CONSTRAINT account_audit_events_actor_type_check
    CHECK (actor_type IN ('user', 'system', 'external_integration')),
  CONSTRAINT account_audit_events_user_actor_check
    CHECK (
      (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_token_id IS NULL) OR
      (actor_type = 'external_integration' AND actor_token_id IS NOT NULL) OR
      (actor_type = 'system')
    ),
  CONSTRAINT account_audit_events_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
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

ALTER TABLE target_issues
  ADD CONSTRAINT fk_target_issues_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE target_issue_observations
  ADD CONSTRAINT fk_target_issue_observations_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE target_metric_history
  ADD CONSTRAINT fk_target_metric_history_workspace_target
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

ALTER TABLE run_tool_approvals
  ADD CONSTRAINT fk_run_tool_approvals_workspace_target
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

CREATE INDEX IF NOT EXISTS idx_user_password_credentials_last_login
  ON user_password_credentials (last_login_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_email_verification_tokens_user_email
  ON user_email_verification_tokens (user_id, email);

CREATE INDEX IF NOT EXISTS idx_user_email_verification_tokens_expires_at
  ON user_email_verification_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_user_password_reset_tokens_user_email
  ON user_password_reset_tokens (user_id, email);

CREATE INDEX IF NOT EXISTS idx_user_password_reset_tokens_expires_at
  ON user_password_reset_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_user_federated_identities_user_id
  ON user_federated_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_user_federated_identities_last_login
  ON user_federated_identities (last_login_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_integration_link_tokens_identity
  ON external_integration_link_tokens (integration_client_id, provider, external_user_id);

CREATE INDEX IF NOT EXISTS idx_external_integration_link_tokens_expires_at
  ON external_integration_link_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_external_integration_user_links_user_id
  ON external_integration_user_links (acornops_user_id);

CREATE INDEX IF NOT EXISTS idx_external_integration_user_links_active
  ON external_integration_user_links (integration_client_id, provider, external_user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_external_integration_user_links_user_active
  ON external_integration_user_links (acornops_user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_workspaces_created_id
  ON workspaces (created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user_id
  ON workspace_memberships (user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_role
  ON workspace_memberships (workspace_id, role);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_role_user
  ON workspace_memberships (workspace_id, role, user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_membership_audit_workspace_created
  ON workspace_membership_audit (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_status
  ON workspace_invitations (workspace_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_role
  ON workspace_invitations (workspace_id, role);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email_status
  ON workspace_invitations (email, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_status_created_id
  ON workspace_invitations (workspace_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_targets_workspace_type
  ON targets (workspace_id, target_type);

CREATE INDEX IF NOT EXISTS idx_targets_workspace_type_status_created_id
  ON targets (workspace_id, target_type, status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_target
  ON sessions (workspace_id, target_id);

CREATE INDEX IF NOT EXISTS idx_sessions_target_last_message
  ON sessions (target_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_target_last_message_id
  ON sessions (workspace_id, target_id, last_message_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_session_created_id
  ON messages (session_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_client_message_id
  ON messages (session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_run_assistant_final
  ON messages (run_id)
  WHERE run_id IS NOT NULL AND kind = 'assistant_final';

CREATE INDEX IF NOT EXISTS idx_runs_session_id
  ON runs (session_id);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id_seq
  ON run_events (run_id, seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_tool_approvals_run_call
  ON run_tool_approvals (run_id, tool_call_id);

CREATE INDEX IF NOT EXISTS idx_run_tool_approvals_run_status
  ON run_tool_approvals (run_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_run_continuations_approval
  ON run_continuations (approval_id);

CREATE INDEX IF NOT EXISTS idx_chat_activity_events_target_replay
  ON chat_activity_events (workspace_id, target_id, id);

CREATE INDEX IF NOT EXISTS idx_chat_activity_events_session
  ON chat_activity_events (session_id, id);

CREATE INDEX IF NOT EXISTS idx_target_tool_overrides_target
  ON target_tool_overrides (target_id);

CREATE INDEX IF NOT EXISTS idx_target_tool_settings_target
  ON target_tool_settings (target_id);

CREATE INDEX IF NOT EXISTS idx_target_insights_entries_target_status
  ON target_insights_entries (target_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_target_insights_entries_workspace_target
  ON target_insights_entries (workspace_id, target_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_target_insights_entries_search
  ON target_insights_entries
  USING GIN (to_tsvector('simple', title || ' ' || body_markdown || ' ' || evidence_summary));

CREATE INDEX IF NOT EXISTS idx_target_insights_entries_tags
  ON target_insights_entries USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_target_insights_checkpoint_jobs_due
  ON target_insights_checkpoint_jobs (status, due_at, retry_after, lease_expires_at)
  WHERE due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_target_insights_checkpoint_jobs_target
  ON target_insights_checkpoint_jobs (workspace_id, target_id, updated_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_target_issues_workspace_order
  ON target_issues (workspace_id, status, severity_rank, last_seen_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_target_issues_workspace_target_order
  ON target_issues (workspace_id, target_id, status, severity_rank, last_seen_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_target_issues_workspace_scope_order
  ON target_issues (workspace_id, scope_name, status, severity_rank, last_seen_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_target_issues_search_trgm
  ON target_issues USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_target_issue_observations_issue_ts
  ON target_issue_observations (issue_id, snapshot_ts DESC, id);

CREATE INDEX IF NOT EXISTS idx_target_metric_history_target_ts
  ON target_metric_history (target_id, sample_ts DESC);

CREATE INDEX IF NOT EXISTS idx_target_metric_history_workspace_target_ts
  ON target_metric_history (workspace_id, target_id, sample_ts DESC);

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

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_workspace_occurred
  ON workspace_audit_events (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_workspace_type
  ON workspace_audit_events (workspace_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_workspace_category
  ON workspace_audit_events (workspace_id, category, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_occurred
  ON workspace_audit_events (occurred_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_account_audit_events_user_occurred
  ON account_audit_events (user_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_account_audit_events_type
  ON account_audit_events (event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_audit_events_occurred
  ON account_audit_events (occurred_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS admin_audit_events_occurred_at_idx
  ON admin_audit_events (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_workspace_idx
  ON admin_audit_events (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_token_idx
  ON admin_audit_events (admin_token_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_action_idx
  ON admin_audit_events (action, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS target_skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'git_import')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_count INTEGER NOT NULL CHECK (file_count >= 1 AND file_count <= 16),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 131072),
  source_repo_url TEXT NULL,
  source_ref TEXT NULL,
  source_subpath TEXT NULL,
  source_commit_sha TEXT NULL,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('not_applicable', 'current', 'modified')),
  created_by TEXT NULL,
  updated_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT target_skills_target_scope_unique UNIQUE (target_id, id),
  CONSTRAINT target_skills_source_metadata_check CHECK (
    (source_type = 'manual'
      AND source_repo_url IS NULL
      AND source_ref IS NULL
      AND source_subpath IS NULL
      AND source_commit_sha IS NULL
      AND sync_status = 'not_applicable')
    OR
    (source_type = 'git_import'
      AND source_repo_url IS NOT NULL
      AND source_ref IS NOT NULL
      AND sync_status IN ('current', 'modified'))
  )
);

CREATE TABLE IF NOT EXISTS target_skill_files (
  skill_id TEXT NOT NULL REFERENCES target_skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 32768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (skill_id, path),
  CONSTRAINT target_skill_files_path_check CHECK (
    path = 'SKILL.md'
    OR (
      path LIKE '%.md'
      AND path NOT LIKE '/%'
      AND path NOT LIKE '%/'
      AND path NOT LIKE '%//%'
      AND path NOT LIKE '../%'
      AND path NOT LIKE '%/../%'
      AND path NOT LIKE './%'
      AND path NOT LIKE '%/./%'
    )
  )
);

CREATE TABLE IF NOT EXISTS run_skill_catalog_snapshots (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  skill_count INTEGER NOT NULL CHECK (skill_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_snapshot_blobs (
  content_hash TEXT PRIMARY KEY,
  files JSONB NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_referenced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run_skill_snapshots (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  skill_ref TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES skill_snapshot_blobs(content_hash),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, skill_ref)
);

CREATE INDEX IF NOT EXISTS idx_target_skills_target_updated
  ON target_skills (target_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_target_skills_target_enabled_valid
  ON target_skills (target_id, enabled, validation_status);

CREATE INDEX IF NOT EXISTS idx_target_skill_files_skill_path
  ON target_skill_files (skill_id, path);

CREATE INDEX IF NOT EXISTS idx_run_skill_snapshots_content_hash
  ON run_skill_snapshots (content_hash);

CREATE INDEX IF NOT EXISTS idx_run_skill_snapshots_run_skill_id
  ON run_skill_snapshots (run_id, skill_id);

CREATE INDEX IF NOT EXISTS idx_skill_snapshot_blobs_last_referenced_at
  ON skill_snapshot_blobs (last_referenced_at);
