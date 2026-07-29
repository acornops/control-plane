CREATE TABLE workspace_defaults (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('mcp_server', 'skill')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  available_in TEXT[] NOT NULL,
  source JSONB NOT NULL,
  content_digest TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_defaults_available_in_check CHECK (
    available_in = ARRAY['agents']::TEXT[]
    OR available_in = ARRAY['kubernetes']::TEXT[]
    OR available_in = ARRAY['virtual_machines']::TEXT[]
    OR available_in = ARRAY['agents', 'kubernetes']::TEXT[]
    OR available_in = ARRAY['agents', 'virtual_machines']::TEXT[]
    OR available_in = ARRAY['kubernetes', 'virtual_machines']::TEXT[]
    OR available_in = ARRAY['agents', 'kubernetes', 'virtual_machines']::TEXT[]
  )
);

CREATE INDEX workspace_defaults_kind_name_idx
  ON workspace_defaults (kind, lower(name), id);

CREATE INDEX workspace_defaults_available_in_idx
  ON workspace_defaults USING GIN (available_in);

CREATE TABLE workspace_default_skill_files (
  default_id TEXT NOT NULL REFERENCES workspace_defaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (default_id, path)
);

CREATE TABLE workspace_initial_defaults (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mcp_server', 'skill')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  available_in TEXT[] NOT NULL,
  source JSONB NOT NULL,
  content_digest TEXT,
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_initial_defaults_available_in_check CHECK (
    available_in = ARRAY['agents']::TEXT[]
    OR available_in = ARRAY['kubernetes']::TEXT[]
    OR available_in = ARRAY['virtual_machines']::TEXT[]
    OR available_in = ARRAY['agents', 'kubernetes']::TEXT[]
    OR available_in = ARRAY['agents', 'virtual_machines']::TEXT[]
    OR available_in = ARRAY['kubernetes', 'virtual_machines']::TEXT[]
    OR available_in = ARRAY['agents', 'kubernetes', 'virtual_machines']::TEXT[]
  )
);

CREATE INDEX workspace_initial_defaults_workspace_kind_idx
  ON workspace_initial_defaults(workspace_id, kind, lower(name), id);

CREATE TABLE workspace_initial_default_skill_files (
  workspace_id TEXT NOT NULL,
  default_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (workspace_id, default_id, path),
  FOREIGN KEY (workspace_id, default_id)
    REFERENCES workspace_initial_defaults(workspace_id, id)
    ON DELETE CASCADE
);
