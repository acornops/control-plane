CREATE TABLE IF NOT EXISTS workspace_ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  default_provider TEXT NOT NULL CHECK (default_provider IN ('openai', 'anthropic', 'gemini')),
  default_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
