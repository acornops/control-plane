-- Keep the Agent definition activity summary compatible with durable approval
-- and uncertain-write states introduced for standalone Agent runs.

ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_last_status_check;
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_last_status_check
  CHECK (last_status IS NULL OR last_status IN (
    'queued', 'running', 'waiting_for_approval', 'needs_review',
    'completed', 'failed', 'cancelled'
  ));
