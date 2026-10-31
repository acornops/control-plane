CREATE INDEX workflow_sessions_retention_idx ON workflow_sessions (created_at, id);
CREATE INDEX workflow_executions_session_idx ON workflow_executions (workflow_session_id);
CREATE INDEX automation_dispatch_outbox_run_idx ON automation_dispatch_outbox (run_id);
