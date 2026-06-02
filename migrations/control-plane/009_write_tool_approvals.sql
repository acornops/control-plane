ALTER TABLE kubernetes_target_settings
  ADD COLUMN IF NOT EXISTS write_confirmation_required_override BOOLEAN NULL;

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE run_tool_approvals
  ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS execution_finished_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS tool_result JSONB NULL,
  ADD COLUMN IF NOT EXISTS tool_result_is_error BOOLEAN NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_tool_approvals_run_call
  ON run_tool_approvals (run_id, tool_call_id);

CREATE INDEX IF NOT EXISTS idx_run_tool_approvals_run_status
  ON run_tool_approvals (run_id, status, created_at DESC);

ALTER TABLE run_tool_approvals
  ADD CONSTRAINT fk_run_tool_approvals_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS run_continuations (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES run_tool_approvals(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_continuations_approval
  ON run_continuations (approval_id);
