-- Durable, HA-safe automation runtime for standalone Agents and sequential Workflows.
-- This migration is additive so deployments can switch AUTOMATION_RUNTIME_MODE off
-- without rolling the database back.

ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS system_template_version INTEGER NULL,
  ADD COLUMN IF NOT EXISTS readiness_status TEXT NOT NULL DEFAULT 'needs_setup',
  ADD COLUMN IF NOT EXISTS readiness_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS client_request_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS target_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS target_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS agent_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS error_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS error_message TEXT NULL,
  ADD COLUMN IF NOT EXISTS assistant_message JSONB NULL,
  ADD COLUMN IF NOT EXISTS usage JSONB NULL;

ALTER TABLE agent_triggers
  ADD COLUMN IF NOT EXISTS secret_ciphertext TEXT NULL,
  ADD COLUMN IF NOT EXISTS next_occurrence_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_workspace_run_unique') THEN
    ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_workspace_run_unique UNIQUE (workspace_id, id);
  END IF;
END $$;

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS system_template_version INTEGER NULL,
  ADD COLUMN IF NOT EXISTS readiness_status TEXT NOT NULL DEFAULT 'needs_setup',
  ADD COLUMN IF NOT EXISTS readiness_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  workflow_session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES workflow_messages(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  trigger_id TEXT NULL,
  occurrence_key TEXT NULL,
  client_request_id TEXT NULL,
  status TEXT NOT NULL,
  current_step_index INTEGER NOT NULL DEFAULT 0 CHECK (current_step_index >= 0),
  workflow_snapshot JSONB NOT NULL CHECK (jsonb_typeof(workflow_snapshot) = 'object'),
  input_context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_context) = 'object'),
  approved_context_grants JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(approved_context_grants) = 'array'),
  cancellation_requested_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflow_definitions(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, trigger_id, occurrence_key),
  UNIQUE (workspace_id, client_request_id)
);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS execution_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS step_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS agent_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS agent_version INTEGER NULL,
  ADD COLUMN IF NOT EXISTS agent_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS step_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS step_scope JSONB NULL,
  ADD COLUMN IF NOT EXISTS target_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS target_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS claim_owner TEXT NULL,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS uncertain_write BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_workflow_run_id_key;

INSERT INTO workflow_executions (
  id, workspace_id, workflow_id, workflow_version, workflow_session_id,
  message_id, created_by, status, workflow_snapshot, started_at, ended_at,
  error_code, error_message, created_at, updated_at
)
SELECT
  wr.workflow_run_id, wr.workspace_id, wr.workflow_id, ws.workflow_version,
  wr.workflow_session_id, wr.message_id, wr.created_by, wr.status,
  jsonb_build_object('id', wr.workflow_id, 'version', ws.workflow_version, 'legacyBackfill', true),
  wr.started_at, wr.ended_at, wr.error_code, wr.error_message, wr.created_at, wr.updated_at
FROM workflow_runs wr
JOIN workflow_sessions ws ON ws.id = wr.workflow_session_id
ON CONFLICT (id) DO NOTHING;

UPDATE workflow_runs
SET execution_id = workflow_run_id,
    idempotency_key = COALESCE(idempotency_key, workflow_run_id || ':0:1')
WHERE execution_id IS NULL OR idempotency_key IS NULL;

ALTER TABLE workflow_runs ALTER COLUMN execution_id SET NOT NULL;
ALTER TABLE workflow_runs ALTER COLUMN idempotency_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_execution_fk') THEN
    ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_execution_fk
      FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_execution_step_attempt_unique') THEN
    ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_execution_step_attempt_unique
      UNIQUE (execution_id, step_index, attempt_number);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_idempotency_key_unique') THEN
    ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_idempotency_key_unique UNIQUE (idempotency_key);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workflow_run_events (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  schema_version INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  schema_version INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (workspace_id, run_id) REFERENCES agent_activity(workspace_id, id) ON DELETE CASCADE
);

INSERT INTO workflow_run_events (run_id, seq, schema_version, event_type, occurred_at, payload)
SELECT wr.id, (event->>'seq')::integer, COALESCE((event->>'schema_version')::integer, 1),
       event->>'type', COALESCE((event->>'ts')::timestamptz, wr.created_at),
       COALESCE(event->'payload', '{}'::jsonb)
FROM workflow_runs wr
CROSS JOIN LATERAL jsonb_array_elements(wr.events) AS event
WHERE jsonb_typeof(wr.events) = 'array' AND event ? 'seq' AND event ? 'type'
ON CONFLICT (run_id, seq) DO NOTHING;

CREATE TABLE IF NOT EXISTS automation_dispatch_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent', 'workflow', 'target')),
  source_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'delivered', 'failed', 'needs_review', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_owner TEXT NULL,
  claim_expires_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  delivered_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automation_trigger_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_type, source_id, occurrence_key)
);

CREATE TABLE IF NOT EXISTS automation_trigger_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES automation_trigger_events(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'delivered', 'rejected', 'failed')),
  rejection_code TEXT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_owner TEXT NULL,
  claim_expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, trigger_id)
);

CREATE TABLE IF NOT EXISTS workflow_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  media_type TEXT NOT NULL DEFAULT 'application/pdf',
  title TEXT NOT NULL,
  source JSONB NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  source_size_bytes INTEGER NOT NULL CHECK (source_size_bytes >= 0),
  retention_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_executions_workspace_status_idx
  ON workflow_executions (workspace_id, status, updated_at, id);
CREATE INDEX IF NOT EXISTS workflow_executions_resumable_idx
  ON workflow_executions (updated_at, id) WHERE status IN ('queued', 'running', 'needs_review', 'failed');
CREATE INDEX IF NOT EXISTS workflow_runs_claim_idx
  ON workflow_runs (next_attempt_at, requested_at, id)
  WHERE status IN ('queued', 'dispatching') AND cancellation_requested_at IS NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_execution_step_idx
  ON workflow_runs (execution_id, step_index, attempt_number DESC);
CREATE INDEX IF NOT EXISTS workflow_run_events_created_idx
  ON workflow_run_events (run_id, created_at, seq);
CREATE INDEX IF NOT EXISTS agent_run_events_created_idx
  ON agent_run_events (run_id, created_at, seq);
CREATE INDEX IF NOT EXISTS automation_dispatch_outbox_claim_idx
  ON automation_dispatch_outbox (next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS automation_dispatch_outbox_depth_idx
  ON automation_dispatch_outbox (workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS automation_trigger_deliveries_claim_idx
  ON automation_trigger_deliveries (next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS agent_triggers_schedule_claim_idx
  ON agent_triggers (next_occurrence_at, workspace_id, agent_id, id)
  WHERE enabled = true AND type = 'schedule';
CREATE UNIQUE INDEX IF NOT EXISTS agent_triggers_global_id_unique ON agent_triggers (id);
CREATE INDEX IF NOT EXISTS workflow_approvals_expiry_idx
  ON workflow_approvals (expires_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS workflow_reports_retention_idx
  ON workflow_reports (retention_expires_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_activity_workspace_client_request_unique
  ON agent_activity (workspace_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_activity_idempotency_unique
  ON agent_activity (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- System templates are created by a database trigger, so all workspace creation
-- paths receive the same catalog and reads never mutate state.
CREATE OR REPLACE FUNCTION seed_workspace_automation_templates(target_workspace_id TEXT, owner_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_definitions (
    workspace_id, id, name, description, instructions, status, source, kind,
    provider_type, version, owner_user_id, created_by, mcp_servers, tools,
    skills, context_grants, target_scope, approval_policy, trust_policy,
    system_template_version, readiness_status, readiness_reasons
  ) VALUES
    (target_workspace_id, 'agent-workflow-orchestrator', 'System Orchestrator',
     'Coordinates deterministic sequential workflow steps.',
     'Dispatch exactly one specialist Agent per executable step. Never expand the compiled step scope.',
     'active', 'system', 'system_orchestrator', 'internal', 1, 'system', 'system',
     '[]', '[]', '[]', '[]', '{"type":"workspace"}',
     '{"mode":"none","writeToolsRequireApproval":true}', '{"level":"restricted","allowExternalData":false}',
     1, 'ready', '[]'),
    (target_workspace_id, 'agent-cluster-triage', 'Kubernetes Diagnostics',
     'Collects live Kubernetes inventory, events, logs, and metrics through AgentK.',
     'Use only target-scoped, read-only AgentK tools and cite observed evidence.',
     'active', 'system', 'specialist_agent', 'internal', 1, owner_id, 'system',
     '["acornops-cluster-agent"]', '["events.search","inventory.resources.list","logs.summarize","metrics.query"]',
     '["acornops-observability","acornops-target-boundary-design"]', '["target_inventory","workspace_metadata"]',
     '{"type":"selected_target","targetTypes":["kubernetes"]}',
     '{"mode":"none","writeToolsRequireApproval":true}', '{"level":"restricted","allowExternalData":false}',
     1, 'needs_setup', '["Select an online Kubernetes target with the required AgentK tools."]'),
    (target_workspace_id, 'agent-release-coordinator', 'Repository Operator',
     'Inspects and changes repositories through the canonical external MCP contract.',
     'Inspect first. Require approval for the exact repository, base, branch, and change plan before any write.',
     'active', 'system', 'specialist_agent', 'external', 1, owner_id, 'system',
     '[]', '["repository.metadata.read","repository.tree.list","repository.file.read","repository.branch.create","repository.commit.create","repository.change_request.create"]', '["acornops-cross-repo-change","acornops-open-pr"]', '["workspace_metadata"]',
     '{"type":"workspace"}', '{"mode":"before_write","writeToolsRequireApproval":true}',
     '{"level":"restricted","allowExternalData":true}', 1, 'needs_setup',
     '["Configure a connected repository MCP server with credentials and all canonical repository tools."]'),
    (target_workspace_id, 'agent-incident-reporter', 'Incident Reporter',
     'Creates retained incident report sources from explicitly selected chat sessions.',
     'Read only explicitly granted same-workspace chats. Persist report source and provenance; never persist PDF bytes.',
     'active', 'system', 'specialist_agent', 'internal', 1, owner_id, 'system',
     '["workspace-chat","artifact-writer"]', '["chat.sessions.read_selected","reports.pdf.generate"]',
     '["acornops-observability"]', '["selected_chat_sessions"]', '{"type":"workspace"}',
     '{"mode":"always","writeToolsRequireApproval":true}', '{"level":"restricted","allowExternalData":false}',
     1, 'ready', '[]')
  ON CONFLICT (workspace_id, id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, instructions = EXCLUDED.instructions,
    mcp_servers = EXCLUDED.mcp_servers, tools = EXCLUDED.tools, skills = EXCLUDED.skills,
    context_grants = EXCLUDED.context_grants, target_scope = EXCLUDED.target_scope,
    approval_policy = EXCLUDED.approval_policy, trust_policy = EXCLUDED.trust_policy,
    system_template_version = EXCLUDED.system_template_version, updated_at = NOW()
  WHERE agent_definitions.source = 'system'
    AND COALESCE(agent_definitions.system_template_version, 0) < EXCLUDED.system_template_version;

  INSERT INTO workflow_definitions (
    workspace_id, id, version, source, template_id, name, description, status,
    category, orchestrator_agent_id, tags, inputs, enabled_mcp_servers,
    enabled_skills, required_permissions, policy, steps, starter_prompt,
    created_by, system_template_version, readiness_status, readiness_reasons
  ) VALUES
    (target_workspace_id, 'cluster-triage', 1, 'system', 'cluster-triage', 'Cluster triage',
     'Inspect a selected online Kubernetes target and summarize likely causes, severity, and next actions.',
     'active', 'cluster-triage', 'agent-workflow-orchestrator', '["cluster","triage","incident"]', '[]',
     '["acornops-cluster-agent"]', '["acornops-observability","acornops-target-boundary-design"]',
     '["read_workspace_data","create_read_only_runs"]',
     '{"mode":"read_only","maxRuntimeSeconds":900,"retentionDays":90,"approvalRequirements":[]}',
     '[{"id":"collect-cluster-signals","title":"Collect cluster signals","requiredInputs":["targetId"],"agentIds":["agent-cluster-triage"],"targetBinding":{"type":"selected_target","targetType":"kubernetes","inputName":"targetId"},"enabledSkills":["acornops-observability","acornops-target-boundary-design"],"allowedMcpServers":["acornops-cluster-agent"],"allowedTools":["inventory.resources.list","events.search","logs.summarize","metrics.query"],"contextGrants":["workspace_metadata","target_inventory"],"approvalRequired":false}]',
     'Triage the selected Kubernetes target using live AgentK evidence.', 'system', 1, 'needs_setup',
     '["Select an online Kubernetes target with all required discovered tools."]'),
    (target_workspace_id, 'repository-operation', 1, 'system', 'repository-operation', 'Repository operation',
     'Inspect and apply an approved provider-neutral repository change through an external MCP server.',
     'active', 'git-operations', 'agent-workflow-orchestrator', '["git","repository","operations"]', '[]', '[]',
     '["acornops-cross-repo-change","acornops-open-pr"]', '["read_workspace_data","create_read_write_runs"]',
     '{"mode":"read_write","maxRuntimeSeconds":1200,"retentionDays":90,"approvalRequirements":["Approve the exact repository/base/branch/change plan"]}',
     '[{"id":"inspect-repository-state","title":"Inspect repository state","requiredInputs":["repository","base"],"agentIds":["agent-release-coordinator"],"enabledSkills":["acornops-cross-repo-change"],"allowedMcpServers":[],"allowedTools":["repository.metadata.read","repository.tree.list","repository.file.read"],"contextGrants":["workspace_metadata"],"approvalRequired":false,"outputArtifacts":[{"id":"change-plan","type":"task_list","title":"Exact repository change plan","required":true}]},{"id":"apply-repository-change","title":"Apply approved repository change","requiredInputs":["repository","base","branch"],"agentIds":["agent-release-coordinator"],"enabledSkills":["acornops-open-pr"],"allowedMcpServers":[],"allowedTools":["repository.branch.create","repository.commit.create","repository.change_request.create"],"contextGrants":["workspace_metadata"],"approvalRequired":true,"outputArtifacts":[{"id":"change-request","type":"task_list","title":"Draft change request","required":true}]}]',
     'Inspect the repository, produce an exact plan, and request approval before writing.', 'system', 1, 'needs_setup',
     '["Configure a connected repository MCP server with credentials and the canonical tool set."]'),
    (target_workspace_id, 'incident-report-pdf', 1, 'system', 'incident-report-pdf', 'Generate incident report from chats',
     'Create a retained report source from explicitly selected chats and render PDF bytes only on download.',
     'active', 'incident-review', 'agent-workflow-orchestrator', '["incident","report","pdf"]', '[]',
     '["workspace-chat","artifact-writer"]', '["acornops-observability"]',
     '["read_workspace_data","create_read_only_runs"]',
     '{"mode":"read_only","maxRuntimeSeconds":1500,"retentionDays":180,"approvalRequirements":["Approve selected chat context"]}',
     '[{"id":"generate-incident-report","title":"Generate incident report","requiredInputs":["chatSessionIds"],"agentIds":["agent-incident-reporter"],"enabledSkills":["acornops-observability"],"allowedMcpServers":["workspace-chat","artifact-writer"],"allowedTools":["chat.sessions.read_selected","reports.pdf.generate"],"contextGrants":["selected_chat_sessions"],"approvalRequired":true,"outputArtifacts":[{"id":"incident-report","type":"pdf","title":"Incident report PDF","required":true}]}]',
     'Generate an incident report from only the selected chats.', 'system', 1, 'ready', '[]')
  ON CONFLICT (workspace_id, id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, policy = EXCLUDED.policy,
    steps = EXCLUDED.steps, starter_prompt = EXCLUDED.starter_prompt,
    system_template_version = EXCLUDED.system_template_version, updated_at = NOW()
  WHERE workflow_definitions.source = 'system'
    AND COALESCE(workflow_definitions.system_template_version, 0) < EXCLUDED.system_template_version;
END $$;

SELECT seed_workspace_automation_templates(id, created_by) FROM workspaces;

CREATE OR REPLACE FUNCTION seed_workspace_automation_templates_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_workspace_automation_templates(NEW.id, NEW.created_by);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workspaces_seed_automation_templates ON workspaces;
CREATE TRIGGER workspaces_seed_automation_templates
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION seed_workspace_automation_templates_trigger();
