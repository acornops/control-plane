-- Extend the existing bounded report store to interactive target-chat runs
-- without moving rendering or persistence into target agents.

ALTER TABLE workflow_reports
  ALTER COLUMN execution_id DROP NOT NULL,
  ALTER COLUMN run_id DROP NOT NULL,
  ADD COLUMN target_run_id TEXT NULL REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE workflow_reports
  ADD CONSTRAINT workflow_reports_exactly_one_run_scope_check
  CHECK (
    (execution_id IS NOT NULL AND run_id IS NOT NULL AND target_run_id IS NULL)
    OR
    (execution_id IS NULL AND run_id IS NULL AND target_run_id IS NOT NULL)
  );

CREATE UNIQUE INDEX workflow_reports_target_run_tool_call_unique
  ON workflow_reports (target_run_id,tool_call_id)
  WHERE target_run_id IS NOT NULL AND tool_call_id IS NOT NULL;

COMMENT ON COLUMN workflow_reports.target_run_id IS
  'Interactive target-chat run that owns this report artifact; mutually exclusive with workflow execution/run scope.';
