-- Restore Agent-owned capability inheritance and make invocation scope an
-- explicit part of every exact reviewed routing mapping.

ALTER TABLE capability_routing_mappings
  ADD COLUMN IF NOT EXISTS invocation_scopes JSONB NOT NULL DEFAULT '["agent","workflow"]'::jsonb
    CHECK (
      jsonb_typeof(invocation_scopes)='array'
      AND invocation_scopes <@ '["agent","workflow"]'::jsonb
    );

-- Stored definitions predate explicit inheritance. Preserve their exact
-- authority by migrating them to restrict. Request compatibility is handled
-- by the API parser, which also defaults omitted fields to restrict.
UPDATE workflow_definitions
SET capability_policy=jsonb_set(capability_policy,'{restrictionMode}','"restrict"'::jsonb,true)
WHERE NOT capability_policy ? 'restrictionMode';

ALTER TABLE workflow_reports
  ADD COLUMN IF NOT EXISTS tool_call_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_reports_run_tool_call_unique
  ON workflow_reports (run_id,tool_call_id)
  WHERE tool_call_id IS NOT NULL;

COMMENT ON COLUMN capability_routing_mappings.invocation_scopes IS
  'Reviewed runtime surfaces on which this exact mapping may be compiled.';
COMMENT ON COLUMN workflow_reports.tool_call_id IS
  'Workflow-native tool idempotency key, unique with run_id.';
