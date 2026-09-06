-- Admission can wait behind a workspace policy lock. Transaction-start timestamps
-- would make a post-restore admission look older than the suspension cutoff.
ALTER TABLE workspace_run_reservations ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE automation_dispatch_outbox ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE target_auto_triage_jobs ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE runs ALTER COLUMN requested_at SET DEFAULT clock_timestamp();
ALTER TABLE workflow_runs ALTER COLUMN requested_at SET DEFAULT clock_timestamp();
