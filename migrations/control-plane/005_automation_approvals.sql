-- Generic durable approval interrupts for standalone Agent runs and Workflow
-- tool writes. Existing target-run and workflow pre-step approval tables remain
-- compatible while automation callbacks share one HA-safe continuation store.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_status_check;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_status_check
  CHECK (status IN (
    'queued', 'running', 'waiting_for_approval', 'needs_review',
    'completed', 'failed', 'cancelled'
  ));

CREATE TABLE IF NOT EXISTS automation_run_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent', 'workflow')),
  source_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  target_id TEXT NULL,
  target_type TEXT NULL,
  approval_kind TEXT NOT NULL CHECK (approval_kind IN ('pre_step', 'tool_write')),
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(arguments) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  execution_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (execution_status IN ('not_started', 'executing', 'succeeded', 'failed', 'unknown')),
  execution_started_at TIMESTAMPTZ NULL,
  execution_finished_at TIMESTAMPTZ NULL,
  tool_result JSONB NULL,
  tool_result_is_error BOOLEAN NULL,
  requested_by TEXT NULL,
  decided_by TEXT NULL,
  decision TEXT NULL CHECK (decision IS NULL OR decision IN ('approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source_type, run_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS automation_run_continuations (
  source_type TEXT NOT NULL CHECK (source_type IN ('agent', 'workflow')),
  run_id TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES automation_run_approvals(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_type, run_id)
);

CREATE INDEX IF NOT EXISTS automation_run_approvals_workspace_status_idx
  ON automation_run_approvals (workspace_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS automation_run_approvals_expiry_idx
  ON automation_run_approvals (expires_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS automation_run_approvals_run_idx
  ON automation_run_approvals (source_type, run_id, created_at, id);
CREATE INDEX IF NOT EXISTS automation_run_continuations_approval_idx
  ON automation_run_continuations (approval_id);
