ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS tool_access_mode TEXT NOT NULL DEFAULT 'read_only';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days');

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS client_message_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_target_last_message
  ON sessions (target_id, last_message_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_client_message_id
  ON messages (session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_run_assistant_final
  ON messages (run_id)
  WHERE run_id IS NOT NULL AND kind = 'assistant_final';

DO $$ BEGIN
  ALTER TABLE messages
    ADD CONSTRAINT fk_messages_session
    FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE runs
    ADD CONSTRAINT fk_runs_session
    FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE run_events
    ADD CONSTRAINT fk_run_events_run
    FOREIGN KEY (run_id)
    REFERENCES runs(id)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
