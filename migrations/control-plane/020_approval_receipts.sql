-- Bind human approval decisions to one exact MCP call. Pre-step approvals do
-- not authorize an MCP dispatch and therefore retain null binding columns.

ALTER TABLE run_tool_approvals
  ADD COLUMN server_id TEXT,
  ADD COLUMN server_tool_name TEXT,
  ADD COLUMN requested_tool_alias TEXT,
  ADD COLUMN arguments_digest TEXT;

UPDATE run_tool_approvals
SET requested_tool_alias=tool_name
WHERE requested_tool_alias IS NULL;

ALTER TABLE run_tool_approvals
  ALTER COLUMN server_id SET NOT NULL,
  ALTER COLUMN server_tool_name SET NOT NULL,
  ALTER COLUMN requested_tool_alias SET NOT NULL,
  ALTER COLUMN arguments_digest SET NOT NULL,
  ADD CONSTRAINT run_tool_approvals_arguments_digest_format
    CHECK (arguments_digest ~ '^[0-9a-f]{64}$');

ALTER TABLE automation_run_approvals
  ADD COLUMN server_id TEXT,
  ADD COLUMN server_tool_name TEXT,
  ADD COLUMN requested_tool_alias TEXT,
  ADD COLUMN arguments_digest TEXT,
  ADD CONSTRAINT automation_run_approvals_exact_tool_binding CHECK (
    approval_kind <> 'tool_write'
    OR (
      server_id IS NOT NULL
      AND server_tool_name IS NOT NULL
      AND requested_tool_alias IS NOT NULL
      AND arguments_digest ~ '^[0-9a-f]{64}$'
    )
  );

COMMENT ON COLUMN run_tool_approvals.arguments_digest IS
  'SHA-256 of RFC 8785 canonical JSON arguments; never emit in logs.';
COMMENT ON COLUMN automation_run_approvals.arguments_digest IS
  'SHA-256 of RFC 8785 canonical JSON arguments for tool_write approvals; never emit in logs.';
