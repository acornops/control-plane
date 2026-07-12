CREATE TABLE IF NOT EXISTS agent_definitions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'draft')),
  source TEXT NOT NULL CHECK (source IN ('system', 'user')),
  kind TEXT NOT NULL CHECK (kind IN ('system_orchestrator', 'specialist_agent')),
  provider_type TEXT NOT NULL CHECK (provider_type IN ('internal', 'external')),
  version INTEGER NOT NULL CHECK (version > 0),
  owner_user_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  mcp_servers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mcp_servers) = 'array'),
  tools JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tools) = 'array'),
  skills JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skills) = 'array'),
  context_grants JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context_grants) = 'array'),
  target_scope JSONB NOT NULL CHECK (jsonb_typeof(target_scope) = 'object'),
  approval_policy JSONB NOT NULL CHECK (jsonb_typeof(approval_policy) = 'object'),
  trust_policy JSONB NOT NULL CHECK (jsonb_typeof(trust_policy) = 'object'),
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  last_run_at TIMESTAMPTZ NULL,
  last_status TEXT NULL CHECK (last_status IS NULL OR last_status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS agent_definitions_workspace_status_idx
  ON agent_definitions (workspace_id, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_definitions_workspace_owner_idx
  ON agent_definitions (workspace_id, owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_triggers (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  name TEXT NULL,
  schedule JSONB NULL CHECK (schedule IS NULL OR jsonb_typeof(schedule) = 'object'),
  event_filter JSONB NULL CHECK (event_filter IS NULL OR jsonb_typeof(event_filter) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, agent_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_versions (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, agent_id, id),
  UNIQUE (workspace_id, agent_id, version, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_versions_agent_created_idx
  ON agent_versions (workspace_id, agent_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_activity (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_version INTEGER NOT NULL CHECK (agent_version > 0),
  trigger_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  triggered_by JSONB NOT NULL CHECK (jsonb_typeof(triggered_by) = 'object'),
  input_context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_context) = 'object'),
  compiled_scope JSONB NOT NULL CHECK (jsonb_typeof(compiled_scope) = 'object'),
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls) = 'array'),
  output_artifacts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(output_artifacts) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, agent_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_activity_agent_created_idx
  ON agent_activity (workspace_id, agent_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  source TEXT NOT NULL CHECK (source IN ('system', 'user')),
  template_id TEXT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'draft', 'paused')),
  category TEXT NOT NULL,
  orchestrator_agent_id TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
  inputs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(inputs) = 'array'),
  enabled_mcp_servers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(enabled_mcp_servers) = 'array'),
  enabled_skills JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(enabled_skills) = 'array'),
  required_permissions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_permissions) = 'array'),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  steps JSONB NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  starter_prompt TEXT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS workflow_definitions_workspace_status_idx
  ON workflow_definitions (workspace_id, status, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS workflow_mcp_servers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  auth_type TEXT NOT NULL,
  public_headers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(public_headers) = 'object'),
  status TEXT NOT NULL,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tools) = 'array'),
  created_by TEXT NOT NULL,
  last_checked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS workflow_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'paused')),
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  input_defaults JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_defaults) = 'object'),
  approved_context_grants JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(approved_context_grants) = 'array'),
  created_by JSONB NOT NULL CHECK (jsonb_typeof(created_by) = 'object'),
  updated_by JSONB NOT NULL CHECK (jsonb_typeof(updated_by) = 'object'),
  next_run_at TIMESTAMPTZ NULL,
  last_run_at TIMESTAMPTZ NULL,
  last_status TEXT NULL,
  last_error TEXT NULL,
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflow_definitions(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workflow_schedules_due_idx
  ON workflow_schedules (next_run_at, id) WHERE status = 'enabled';
CREATE INDEX IF NOT EXISTS workflow_schedules_workspace_idx
  ON workflow_schedules (workspace_id, next_run_at, id);

CREATE TABLE IF NOT EXISTS workflow_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  created_by TEXT NOT NULL,
  compiled_access_scope JSONB NOT NULL CHECK (jsonb_typeof(compiled_access_scope) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflow_definitions(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workflow_sessions_workflow_created_idx
  ON workflow_sessions (workspace_id, workflow_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS workflow_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(inputs) = 'object'),
  run_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_messages_session_created_idx
  ON workflow_messages (session_id, created_at, id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT UNIQUE NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  workflow_step_id TEXT NULL,
  message_id TEXT NOT NULL REFERENCES workflow_messages(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  compiled_access_scope JSONB NOT NULL CHECK (jsonb_typeof(compiled_access_scope) = 'object'),
  llm_provider TEXT NULL,
  llm_model TEXT NULL,
  llm_reasoning_summary_mode TEXT NULL,
  llm_reasoning_effort TEXT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  assistant_message JSONB NULL CHECK (assistant_message IS NULL OR jsonb_typeof(assistant_message) = 'object'),
  usage JSONB NULL,
  events JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(events) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_runs_session_requested_idx
  ON workflow_runs (workflow_session_id, requested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_workspace_status_idx
  ON workflow_runs (workspace_id, status, requested_at DESC, id DESC);

ALTER TABLE workflow_messages
  ADD CONSTRAINT workflow_messages_run_fk
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  workflow_session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  workflow_step_id TEXT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(arguments) = 'object'),
  status TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  requested_by TEXT NULL,
  decided_by TEXT NULL,
  decision TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_approvals_workspace_status_idx
  ON workflow_approvals (workspace_id, status, created_at DESC, id DESC);

