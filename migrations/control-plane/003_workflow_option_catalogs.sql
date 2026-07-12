CREATE TABLE IF NOT EXISTS workspace_skills (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('system', 'workspace')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  validation_status TEXT NOT NULL DEFAULT 'valid' CHECK (validation_status IN ('valid', 'invalid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_skills_name_unique UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS workspace_skills_workspace_enabled_valid_name_idx
  ON workspace_skills (workspace_id, enabled, validation_status, name, id);
