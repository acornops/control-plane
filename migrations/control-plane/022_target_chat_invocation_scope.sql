-- Allow reviewed workspace-native mappings to be compiled for interactive
-- target-chat runs while preserving the existing Agent and workflow scopes.

ALTER TABLE capability_routing_mappings
  DROP CONSTRAINT IF EXISTS capability_routing_mappings_invocation_scopes_check;

ALTER TABLE capability_routing_mappings
  ADD CONSTRAINT capability_routing_mappings_invocation_scopes_check
  CHECK (
    jsonb_typeof(invocation_scopes)='array'
    AND invocation_scopes <@ '["agent","workflow","target_chat"]'::jsonb
  ) NOT VALID;

ALTER TABLE capability_routing_mappings
  VALIDATE CONSTRAINT capability_routing_mappings_invocation_scopes_check;
