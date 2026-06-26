CREATE TABLE IF NOT EXISTS target_tool_settings (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, tool_id)
);

CREATE INDEX IF NOT EXISTS idx_target_tool_settings_target
  ON target_tool_settings (target_id);
