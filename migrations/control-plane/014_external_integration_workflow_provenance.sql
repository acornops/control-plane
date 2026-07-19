-- Durable provenance and replay state for externally requested Workflow executions.

ALTER TABLE workflow_sessions
  ADD COLUMN IF NOT EXISTS workflow_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS request_actor_type TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS request_external_integration_link_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS request_external_integration_client_id TEXT NULL;

UPDATE workflow_sessions session
SET workflow_snapshot = jsonb_build_object(
  'id', definition.id,
  'workspaceId', definition.workspace_id,
  'version', session.workflow_version,
  'source', definition.source,
  'templateId', definition.template_id,
  'name', definition.name,
  'description', definition.description,
  'status', definition.status,
  'category', definition.category,
  'orchestratorAgentId', definition.orchestrator_agent_id,
  'tags', definition.tags,
  'inputs', definition.inputs,
  'enabledMcpServers', definition.enabled_mcp_servers,
  'enabledSkills', definition.enabled_skills,
  'requiredPermissions', definition.required_permissions,
  'policy', definition.policy,
  'steps', definition.steps,
  'starterPrompt', definition.starter_prompt,
  'createdBy', definition.created_by,
  'createdAt', definition.created_at,
  'updatedAt', definition.updated_at,
  'readiness', jsonb_build_object(
    'status', definition.readiness_status,
    'reasons', definition.readiness_reasons
  )
)
FROM workflow_definitions definition
WHERE session.workspace_id = definition.workspace_id
  AND session.workflow_id = definition.id
  AND session.workflow_snapshot IS NULL;

ALTER TABLE workflow_sessions
  ALTER COLUMN workflow_snapshot SET NOT NULL;

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS request_actor_type TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS request_external_integration_link_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS request_external_integration_client_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_sessions_request_actor_provenance_check'
  ) THEN
    ALTER TABLE workflow_sessions
      ADD CONSTRAINT workflow_sessions_request_actor_provenance_check CHECK (
        (
          request_actor_type = 'user'
          AND request_external_integration_link_id IS NULL
          AND request_external_integration_client_id IS NULL
        )
        OR
        (
          request_actor_type = 'external_integration'
          AND request_external_integration_link_id IS NOT NULL
          AND request_external_integration_client_id IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_executions_request_actor_provenance_check'
  ) THEN
    ALTER TABLE workflow_executions
      ADD CONSTRAINT workflow_executions_request_actor_provenance_check CHECK (
        (
          request_actor_type = 'user'
          AND request_external_integration_link_id IS NULL
          AND request_external_integration_client_id IS NULL
        )
        OR
        (
          request_actor_type = 'external_integration'
          AND request_external_integration_link_id IS NOT NULL
          AND request_external_integration_client_id IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workflow_sessions_external_integration_origin
  ON workflow_sessions (request_external_integration_link_id, created_at DESC)
  WHERE request_actor_type = 'external_integration';

CREATE INDEX IF NOT EXISTS idx_workflow_executions_external_integration_origin
  ON workflow_executions (request_external_integration_link_id, updated_at DESC)
  WHERE request_actor_type = 'external_integration';

CREATE TABLE IF NOT EXISTS workflow_execution_events (
  id BIGSERIAL PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  run_id TEXT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  run_event_seq INTEGER NULL,
  step_index INTEGER NULL,
  approval_id TEXT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS workflow_execution_events_replay_idx
  ON workflow_execution_events (execution_id, id);
