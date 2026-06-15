ALTER TABLE run_tool_approvals
  ADD COLUMN IF NOT EXISTS summary TEXT;
