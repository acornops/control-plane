-- Workflow Agent V2. This is the sole migration allowed to name legacy
-- generated definition identifiers: they are cleanup inputs, never runtime
-- routing identities.

-- Workflow V2 is an intentionally greenfield schema epoch. Fail before the
-- first mutation when state exists that cannot be translated without changing
-- its meaning. Operators must back up and reset the database explicitly.
DO $$
DECLARE
  workflow_definition_count BIGINT;
  workflow_schedule_count BIGINT;
  workflow_session_count BIGINT;
  workflow_continuation_count BIGINT;
  workflow_approval_count BIGINT;
  workflow_gate_approval_count BIGINT;
  run_continuation_count BIGINT;
  run_tool_approval_count BIGINT;
  active_run_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO workflow_definition_count FROM workflow_definitions;
  SELECT COUNT(*) INTO workflow_schedule_count FROM workflow_schedules;
  SELECT COUNT(*) INTO workflow_session_count FROM workflow_sessions;
  SELECT COUNT(*) INTO workflow_continuation_count
    FROM automation_run_continuations WHERE source_type='workflow';
  SELECT COUNT(*) INTO workflow_approval_count
    FROM automation_run_approvals WHERE source_type='workflow';
  SELECT COUNT(*) INTO workflow_gate_approval_count FROM workflow_approvals;
  SELECT COUNT(*) INTO run_continuation_count FROM run_continuations;
  SELECT COUNT(*) INTO run_tool_approval_count FROM run_tool_approvals;
  SELECT COUNT(*) INTO active_run_count FROM runs
    WHERE status IN ('queued','dispatching','running','waiting_for_approval','cancelling');

  IF workflow_definition_count > 0
     OR workflow_schedule_count > 0
     OR workflow_session_count > 0
     OR workflow_continuation_count > 0
     OR workflow_approval_count > 0
     OR workflow_gate_approval_count > 0
     OR run_continuation_count > 0
     OR run_tool_approval_count > 0
     OR active_run_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'WORKFLOW_V2_DATABASE_RESET_REQUIRED';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS automation_template_installations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
  installed_by TEXT NOT NULL,
  record_ids JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record_ids)='object'),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, template_id)
);

-- Convert manually-created Agents in place. Origin is attribution only and is
-- deliberately absent from authorization and scope tables.
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS origin JSONB NOT NULL DEFAULT '{"type":"manual"}'::jsonb
    CHECK (
      jsonb_typeof(origin)='object'
      AND origin->>'type' IN ('template', 'manual')
    ),
  ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'reviewed'
    CHECK (review_state IN ('draft', 'reviewed', 'rejected')),
  ADD COLUMN IF NOT EXISTS semantic_capability_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(semantic_capability_ids)='array');

ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_kind_check;

UPDATE agent_definitions
SET origin = CASE
      WHEN source='system' THEN jsonb_strip_nulls(jsonb_build_object(
        'type', 'template',
        'templateId', COALESCE(NULLIF(id, ''), 'legacy'),
        'templateVersion', system_template_version
      ))
      ELSE '{"type":"manual"}'::jsonb
    END,
    kind = CASE WHEN kind='system_orchestrator' THEN 'manager' ELSE 'specialist' END,
    status = CASE WHEN source='system' THEN 'disabled' ELSE status END,
    review_state = 'reviewed',
    semantic_capability_ids = '[]'::jsonb,
    readiness_status = 'needs_setup',
    readiness_reasons = '["Capability mappings must be reviewed against the live catalog."]'::jsonb;

ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_kind_check
  CHECK (kind IN ('manager', 'specialist'));

-- Managers are coordination-only. Legacy operational bindings are not carried
-- forward; specialists retain administrator-installed snapshots for review.
UPDATE agent_definitions
SET provider_type='internal',
    mcp_servers='[]'::jsonb,
    mcp_tools='[]'::jsonb,
    mcp_installations='[]'::jsonb,
    tools='[]'::jsonb,
    skills='[]'::jsonb,
    skill_installations='[]'::jsonb,
    context_grants='[]'::jsonb,
    permission_mode='read_only'
WHERE kind='manager';

ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_manager_coordination_only;
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_manager_coordination_only CHECK (
  kind <> 'manager' OR (
    mcp_servers='[]'::jsonb
    AND mcp_tools='[]'::jsonb
    AND mcp_installations='[]'::jsonb
    AND tools='[]'::jsonb
    AND skills='[]'::jsonb
    AND skill_installations='[]'::jsonb
    AND context_grants='[]'::jsonb
  )
);

ALTER TABLE agent_definitions
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS system_template_version;

CREATE TABLE IF NOT EXISTS capability_routing_mappings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  agent_id TEXT NOT NULL,
  agent_version INTEGER NOT NULL CHECK (agent_version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  review_state TEXT NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft', 'reviewed', 'rejected')),
  priority INTEGER NOT NULL DEFAULT 100,
  target_types JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(target_types)='array'),
  target_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(target_ids)='array'),
  mcp_tools JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mcp_tools)='array'),
  native_tool_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(native_tool_ids)='array'),
  skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skill_ids)='array'),
  context_grants JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context_grants)='array'),
  created_by TEXT NOT NULL,
  reviewed_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS capability_routing_lookup_idx
  ON capability_routing_mappings (workspace_id, capability_id, status, review_state, priority, id);

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS origin JSONB NOT NULL DEFAULT '{"type":"manual"}'::jsonb
    CHECK (
      jsonb_typeof(origin)='object'
      AND origin->>'type' IN ('template', 'manual')
    ),
  ADD COLUMN IF NOT EXISTS prompt TEXT,
  ADD COLUMN IF NOT EXISTS entry_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS target_constraints JSONB NULL
    CHECK (target_constraints IS NULL OR jsonb_typeof(target_constraints)='object'),
  ADD COLUMN IF NOT EXISTS capability_policy JSONB,
  ADD COLUMN IF NOT EXISTS delegation_policy JSONB NULL
    CHECK (delegation_policy IS NULL OR jsonb_typeof(delegation_policy)='object');

ALTER TABLE workflow_definitions
  ALTER COLUMN prompt SET NOT NULL,
  ALTER COLUMN entry_agent_id SET NOT NULL,
  ALTER COLUMN capability_policy SET NOT NULL;

ALTER TABLE workflow_definitions
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS orchestrator_agent_id,
  DROP COLUMN IF EXISTS policy,
  DROP COLUMN IF EXISTS steps,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS system_template_version;

-- V2 has one entry run. Remove the V1 step identity from live runtime and
-- approval tables after transient runtime state is cleared above.
DROP INDEX IF EXISTS workflow_runs_execution_step_idx;
ALTER TABLE workflow_runs
  DROP CONSTRAINT IF EXISTS workflow_runs_execution_step_attempt_unique;
ALTER TABLE workflow_runs
  DROP COLUMN IF EXISTS workflow_step_id,
  DROP COLUMN IF EXISTS step_index,
  DROP COLUMN IF EXISTS step_snapshot,
  DROP COLUMN IF EXISTS step_scope;
ALTER TABLE workflow_executions DROP COLUMN IF EXISTS current_step_index;
ALTER TABLE workflow_approvals DROP COLUMN IF EXISTS workflow_step_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='workflow_definitions_entry_agent_fk'
      AND connamespace = current_schema()::regnamespace
  ) THEN
    ALTER TABLE workflow_definitions ADD CONSTRAINT workflow_definitions_entry_agent_fk
      FOREIGN KEY (workspace_id, entry_agent_id)
      REFERENCES agent_definitions(workspace_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Persist delegation as child executions whose scope is already compiled and
-- may only be narrowed by dispatch, continuation, approval, and tool execution.
CREATE TABLE IF NOT EXISTS workflow_delegations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  child_run_id TEXT NULL,
  capability_id TEXT NOT NULL,
  target_binding JSONB NOT NULL CHECK (jsonb_typeof(target_binding)='object'),
  task_prompt TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  selected_agent_id TEXT NOT NULL,
  selected_agent_version INTEGER NOT NULL CHECK (selected_agent_version > 0),
  compiled_scope JSONB NOT NULL CHECK (jsonb_typeof(compiled_scope)='object'),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  result JSONB NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, selected_agent_id)
    REFERENCES agent_definitions(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workflow_delegations_parent_idx
  ON workflow_delegations (parent_execution_id, status, created_at, id);

ALTER TABLE sessions
  DROP COLUMN IF EXISTS selected_agent_id,
  DROP COLUMN IF EXISTS selected_agent_version,
  DROP COLUMN IF EXISTS selected_agent_snapshot;

ALTER TABLE runs
  DROP COLUMN IF EXISTS agent_id,
  DROP COLUMN IF EXISTS agent_version,
  DROP COLUMN IF EXISTS agent_snapshot;

-- Remove every historical seeder/guard. New records are created only by the
-- common application definition service.
DROP TRIGGER IF EXISTS workspaces_seed_automation_templates ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_system_skills ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_cluster_triage_v2 ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_workflow_prompt_references_v3 ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_system_automation_v4 ON workspaces;
DROP TRIGGER IF EXISTS agent_definitions_guard_system_mutation ON agent_definitions;
DROP TRIGGER IF EXISTS workflow_definitions_guard_system_mutation ON workflow_definitions;

DROP FUNCTION IF EXISTS seed_workspace_automation_templates(TEXT, TEXT);
DROP FUNCTION IF EXISTS seed_workspace_automation_templates_trigger();
DROP FUNCTION IF EXISTS seed_workspace_system_skills(TEXT);
DROP FUNCTION IF EXISTS seed_workspace_system_skills_trigger();
DROP FUNCTION IF EXISTS seed_workspace_cluster_triage_v2(TEXT, TEXT);
DROP FUNCTION IF EXISTS seed_workspace_cluster_triage_v2_trigger();
DROP FUNCTION IF EXISTS seed_workspace_workflow_prompt_references_v3(TEXT, TEXT);
DROP FUNCTION IF EXISTS seed_workspace_workflow_prompt_references_v3_trigger();
DROP FUNCTION IF EXISTS seed_workspace_system_automation_v4(TEXT);
DROP FUNCTION IF EXISTS seed_workspace_system_automation_v4_trigger();
DROP FUNCTION IF EXISTS guard_system_agent_definition_mutation();
DROP FUNCTION IF EXISTS guard_system_workflow_definition_mutation();

DROP TABLE IF EXISTS system_agent_workspace_configuration;
DROP TABLE IF EXISTS system_workflow_workspace_configuration;
DROP TABLE IF EXISTS automation_template_install_candidates;

COMMENT ON COLUMN agent_definitions.origin IS
  'Attribution only. Origin must never participate in authorization, validation, readiness, or scope compilation.';
COMMENT ON COLUMN workflow_definitions.origin IS
  'Attribution only. Template and manual definitions share one runtime path.';
COMMENT ON TABLE automation_template_installations IS
  'One-time automation provisioning markers. Complete rows remain tombstones after users delete starter definitions.';
COMMENT ON TABLE capability_routing_mappings IS
  'Reviewed semantic-to-exact resource mappings; semantic labels alone never authorize execution.';
