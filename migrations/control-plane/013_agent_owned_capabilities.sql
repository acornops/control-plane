-- Add Agent-owned capability snapshots without modifying target-owned MCP or
-- skill configuration. Runtime authority is resolved later through reviewed
-- semantic capability mappings; these columns only preserve administrator
-- configuration and immutable version snapshots.

ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS mcp_tools JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(mcp_tools) = 'array'),
  ADD COLUMN IF NOT EXISTS mcp_installations JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(mcp_installations) = 'array'),
  ADD COLUMN IF NOT EXISTS skill_installations JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(skill_installations) = 'array'),
  ADD COLUMN IF NOT EXISTS permission_mode TEXT NOT NULL DEFAULT 'ask_before_changes'
    CHECK (permission_mode IN ('read_only', 'ask_before_changes', 'auto_allowed_changes')),
  ADD COLUMN IF NOT EXISTS delegate_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(delegate_agent_ids) = 'array');

ALTER TABLE agent_triggers
  ADD COLUMN IF NOT EXISTS principal JSONB NULL
    CHECK (
      principal IS NULL OR (
        jsonb_typeof(principal) = 'object'
        AND principal->>'type' IN ('user', 'service_identity')
        AND COALESCE(principal->>'id', '') <> ''
      )
    );

ALTER TABLE workflow_schedules
  ADD COLUMN IF NOT EXISTS principal JSONB NULL
    CHECK (
      principal IS NULL OR (
        jsonb_typeof(principal) = 'object'
        AND principal->>'type' IN ('user', 'service_identity')
        AND COALESCE(principal->>'id', '') <> ''
      )
    );

UPDATE workflow_schedules
SET status='paused',
    last_error='Select an explicit delegated user or service identity before re-enabling this schedule.',
    next_run_at=NULL,
    lease_owner=NULL,
    lease_expires_at=NULL
WHERE principal IS NULL;

CREATE TABLE IF NOT EXISTS service_identities (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS service_identities_workspace_status_idx
  ON service_identities (workspace_id, status, id);

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS principal JSONB NULL
    CHECK (
      principal IS NULL OR (
        jsonb_typeof(principal) = 'object'
        AND principal->>'type' IN ('user', 'service_identity')
        AND COALESCE(principal->>'id','') <> ''
      )
    );

CREATE TABLE IF NOT EXISTS agent_skills (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'git', 'template')),
  source_url TEXT NULL,
  source_ref TEXT NULL,
  source_path TEXT NULL,
  pinned_commit TEXT NULL,
  provenance JSONB NULL CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object'),
  content_digest TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, agent_id, id),
  UNIQUE (workspace_id, agent_id, name),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES agent_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_skill_files (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, agent_id, skill_id, path),
  FOREIGN KEY (workspace_id, agent_id, skill_id)
    REFERENCES agent_skills(workspace_id, agent_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_skills_agent_enabled_idx
  ON agent_skills (workspace_id, agent_id, enabled, name);

-- Historical seed functions are removed here. The following migration converts
-- existing definitions and the application service performs any explicit
-- template installation through the normal definition commands.
DROP TRIGGER IF EXISTS workspaces_seed_automation_templates ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_system_skills ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_cluster_triage_v2 ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_workflow_prompt_references_v3 ON workspaces;
DROP TRIGGER IF EXISTS workspaces_seed_system_automation_v4 ON workspaces;

DROP FUNCTION IF EXISTS seed_workspace_automation_templates_trigger();
DROP FUNCTION IF EXISTS seed_workspace_system_skills_trigger();
DROP FUNCTION IF EXISTS seed_workspace_cluster_triage_v2_trigger();
DROP FUNCTION IF EXISTS seed_workspace_workflow_prompt_references_v3_trigger();
DROP FUNCTION IF EXISTS seed_workspace_system_automation_v4_trigger();

COMMENT ON COLUMN agent_definitions.mcp_installations IS
  'Secret-free Agent-owned MCP installation snapshots; immutable copies are stored in Agent versions and runs.';
COMMENT ON COLUMN agent_triggers.principal IS
  'Delegated user or service identity for scheduled, webhook, and target-event runs.';
COMMENT ON COLUMN workflow_schedules.principal IS
  'Explicit delegated user or service identity; current workspace authorization is rechecked for every dispatch.';
