-- Public workflows select specialist Agents. The control plane derives whether
-- to execute directly or through one persistent workspace coordinator.

ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS system_role TEXT NULL
    CHECK (system_role IS NULL OR system_role='workflow_coordinator');

ALTER TABLE agent_definitions
  DROP CONSTRAINT IF EXISTS agent_definitions_system_role_kind;
ALTER TABLE agent_definitions
  ADD CONSTRAINT agent_definitions_system_role_kind CHECK (
    system_role IS NULL OR kind='manager'
  );

CREATE UNIQUE INDEX IF NOT EXISTS agent_definitions_workspace_system_role_unique
  ON agent_definitions (workspace_id, system_role)
  WHERE system_role IS NOT NULL;

-- Old explicit Managers remain as disabled historical rows. They are never
-- promoted because definition origin is attribution, not authorization.
UPDATE agent_definitions
SET status='disabled',
    readiness_status='blocked',
    readiness_reasons='["MANAGER_SYSTEM_OWNED"]'::jsonb,
    updated_at=NOW()
WHERE kind='manager' AND system_role IS NULL;

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS agent_ids JSONB NULL
    CHECK (agent_ids IS NULL OR jsonb_typeof(agent_ids)='array');

ALTER TABLE workflow_sessions
  ADD COLUMN IF NOT EXISTS workflow_snapshot JSONB NULL
    CHECK (workflow_snapshot IS NULL OR jsonb_typeof(workflow_snapshot)='object');

UPDATE workflow_sessions session
SET workflow_snapshot=(
  SELECT execution.workflow_snapshot
  FROM workflow_executions execution
  WHERE execution.workflow_session_id=session.id
  ORDER BY execution.created_at DESC,execution.id DESC
  LIMIT 1
)
WHERE session.workflow_snapshot IS NULL
  AND EXISTS (
    SELECT 1
    FROM workflow_executions execution
    WHERE execution.workflow_session_id=session.id
  );

-- A direct legacy specialist becomes the sole selected Agent. A legacy Manager
-- derives its selected peers from the workflow restriction, falling back to
-- the Manager allowlist. Selection order is canonicalized by stable ID.
WITH derived AS (
  SELECT workflow.workspace_id,
         workflow.id,
         CASE
           WHEN entry_agent.kind='specialist' THEN jsonb_build_array(entry_agent.id)
           ELSE COALESCE((
             SELECT jsonb_agg(candidate.id ORDER BY candidate.id)
             FROM (
               SELECT DISTINCT specialist.id
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_array_length(COALESCE(workflow.delegation_policy->'specialistAgentIds','[]'::jsonb)) > 0
                     THEN workflow.delegation_policy->'specialistAgentIds'
                   ELSE COALESCE(entry_agent.delegate_agent_ids,'[]'::jsonb)
                 END
               ) selected(id)
               JOIN agent_definitions specialist
                 ON specialist.workspace_id=workflow.workspace_id
                AND specialist.id=selected.id
                AND specialist.kind='specialist'
             ) candidate
           ), '[]'::jsonb)
         END AS agent_ids
  FROM workflow_definitions workflow
  JOIN agent_definitions entry_agent
    ON entry_agent.workspace_id=workflow.workspace_id
   AND entry_agent.id=workflow.entry_agent_id
)
UPDATE workflow_definitions workflow
SET agent_ids=derived.agent_ids
FROM derived
WHERE workflow.workspace_id=derived.workspace_id AND workflow.id=derived.id;

UPDATE workflow_definitions
SET agent_ids='[]'::jsonb,
    status='paused',
    readiness_status='blocked',
    readiness_reasons='["WORKFLOW_AGENT_SELECTION_REQUIRED"]'::jsonb,
    updated_at=NOW()
WHERE agent_ids IS NULL OR jsonb_array_length(agent_ids)=0;

UPDATE workflow_definitions
SET entry_agent_id=agent_ids->>0,
    delegation_policy=NULL,
    updated_at=NOW()
WHERE jsonb_array_length(agent_ids)=1;

-- Runtime startup normalization provisions the persistent coordinator through
-- the common definition service and atomically replaces the legacy entry ID.
UPDATE workflow_definitions
SET delegation_policy=jsonb_build_object(
      'specialistAgentIds', agent_ids,
      'maxConcurrentChildren', 4,
      'maxChildren', 8
    ), updated_at=NOW()
WHERE jsonb_array_length(agent_ids)>1;

ALTER TABLE workflow_definitions
  ALTER COLUMN agent_ids SET NOT NULL;

ALTER TABLE workflow_definitions
  DROP CONSTRAINT IF EXISTS workflow_definitions_agent_ids_nonempty;
ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_agent_ids_nonempty CHECK (
    jsonb_array_length(agent_ids)>0
    OR (
      status='paused'
      AND readiness_status='blocked'
      AND readiness_reasons ? 'WORKFLOW_AGENT_SELECTION_REQUIRED'
    )
  );

COMMENT ON COLUMN agent_definitions.system_role IS
  'Authorization marker for system-owned infrastructure. Origin is attribution only.';
COMMENT ON COLUMN workflow_definitions.agent_ids IS
  'Canonical, order-independent public specialist Agent selection. Internal entry and delegation fields are derived execution policy.';
