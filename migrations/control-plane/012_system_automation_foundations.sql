-- Unreleased catalog foundation. Generated automation definitions are installed
-- by the application template service; database migrations never seed them.

ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS mcp_tools JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(mcp_tools) = 'array'),
  ADD COLUMN IF NOT EXISTS mcp_installations JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(mcp_installations) = 'array'),
  ADD COLUMN IF NOT EXISTS permission_mode TEXT NOT NULL DEFAULT 'ask_before_changes'
    CHECK (permission_mode IN ('read_only', 'ask_before_changes', 'auto_allowed_changes')),
  ADD COLUMN IF NOT EXISTS delegate_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(delegate_agent_ids) = 'array');

ALTER TABLE agent_triggers
  ADD COLUMN IF NOT EXISTS principal JSONB NULL
    CHECK (principal IS NULL OR jsonb_typeof(principal) = 'object');

DROP TRIGGER IF EXISTS workspaces_seed_system_automation_v4 ON workspaces;
DROP FUNCTION IF EXISTS seed_workspace_system_automation_v4_trigger();
DROP FUNCTION IF EXISTS seed_workspace_system_automation_v4(TEXT);
