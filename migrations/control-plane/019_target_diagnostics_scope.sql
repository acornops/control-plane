ALTER TABLE capability_routing_mappings
  ADD COLUMN IF NOT EXISTS target_tool_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(target_tool_refs)='array');

COMMENT ON COLUMN capability_routing_mappings.target_tool_refs IS
  'Target-native built-in tool grants. These are resolved only for one exact target and are not remote MCP grants.';
