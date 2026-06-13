ALTER TABLE workspace_ai_settings
  ADD COLUMN IF NOT EXISTS reasoning_summary_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed')),
  ADD COLUMN IF NOT EXISTS reasoning_effort TEXT NOT NULL DEFAULT 'default'
    CHECK (reasoning_effort IN ('default', 'low', 'medium', 'high'));

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS llm_reasoning_summary_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (llm_reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed')),
  ADD COLUMN IF NOT EXISTS llm_reasoning_effort TEXT NOT NULL DEFAULT 'default'
    CHECK (llm_reasoning_effort IN ('default', 'low', 'medium', 'high'));
