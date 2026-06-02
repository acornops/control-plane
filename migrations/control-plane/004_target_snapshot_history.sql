CREATE TABLE IF NOT EXISTS target_snapshot_history (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_ts TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_target_snapshot_history_target_ts
  ON target_snapshot_history (target_id, snapshot_ts DESC);

CREATE INDEX IF NOT EXISTS idx_target_snapshot_history_workspace_target_ts
  ON target_snapshot_history (workspace_id, target_id, snapshot_ts DESC);

ALTER TABLE target_snapshot_history
  ADD CONSTRAINT fk_target_snapshot_history_workspace_target
  FOREIGN KEY (workspace_id, target_id)
  REFERENCES targets(workspace_id, id)
  ON DELETE CASCADE;
