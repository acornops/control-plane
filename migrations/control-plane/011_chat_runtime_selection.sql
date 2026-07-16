CREATE INDEX IF NOT EXISTS idx_runs_session_requested
  ON runs (session_id, requested_at DESC, id DESC);
