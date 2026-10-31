-- Cascading target deletion clears these references for every session and run.
-- Index the FK lookups so they do not repeatedly scan unrelated triage history.
CREATE INDEX idx_target_auto_triage_jobs_run_id ON target_auto_triage_jobs (run_id);
CREATE INDEX idx_target_auto_triage_jobs_session_id ON target_auto_triage_jobs (session_id);
