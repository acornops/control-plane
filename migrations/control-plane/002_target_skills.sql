CREATE TABLE IF NOT EXISTS target_skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'git_import')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_count INTEGER NOT NULL CHECK (file_count >= 1 AND file_count <= 16),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 131072),
  source_repo_url TEXT NULL,
  source_ref TEXT NULL,
  source_subpath TEXT NULL,
  source_commit_sha TEXT NULL,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('not_applicable', 'current', 'modified')),
  created_by TEXT NULL,
  updated_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT target_skills_target_scope_unique UNIQUE (target_id, id),
  CONSTRAINT target_skills_source_metadata_check CHECK (
    (source_type = 'manual'
      AND source_repo_url IS NULL
      AND source_ref IS NULL
      AND source_subpath IS NULL
      AND source_commit_sha IS NULL
      AND sync_status = 'not_applicable')
    OR
    (source_type = 'git_import'
      AND source_repo_url IS NOT NULL
      AND source_ref IS NOT NULL
      AND source_commit_sha IS NOT NULL
      AND sync_status IN ('current', 'modified'))
  )
);

CREATE TABLE IF NOT EXISTS target_skill_files (
  skill_id TEXT NOT NULL REFERENCES target_skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 32768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (skill_id, path),
  CONSTRAINT target_skill_files_path_check CHECK (
    path = 'SKILL.md'
    OR (path LIKE 'references/%' AND path LIKE '%.md')
  )
);

CREATE INDEX IF NOT EXISTS idx_target_skills_target_updated
  ON target_skills (target_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_target_skills_target_enabled_valid
  ON target_skills (target_id, enabled, validation_status);

CREATE INDEX IF NOT EXISTS idx_target_skill_files_skill_path
  ON target_skill_files (skill_id, path);
