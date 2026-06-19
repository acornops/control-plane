CREATE TABLE IF NOT EXISTS chat_activity_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine')),
  session_id TEXT NOT NULL,
  run_id TEXT NULL,
  message_id TEXT NULL,
  approval_id TEXT NULL,
  type TEXT NOT NULL CHECK (
    type IN (
      'message.created',
      'run.created',
      'run.status_changed',
      'assistant_message.committed',
      'approval.requested',
      'approval.decided',
      'approval.expired',
      'session.deleted'
    )
  ),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_chat_activity_events_workspace_target
    FOREIGN KEY (workspace_id, target_id)
    REFERENCES targets(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_activity_events_target_replay
  ON chat_activity_events (workspace_id, target_id, id);

CREATE INDEX IF NOT EXISTS idx_chat_activity_events_session
  ON chat_activity_events (session_id, id);
