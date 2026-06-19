ALTER TABLE workspace_ai_settings
  ALTER COLUMN reasoning_summary_mode SET DEFAULT 'auto';

ALTER TABLE runs
  ALTER COLUMN llm_reasoning_summary_mode SET DEFAULT 'auto';

UPDATE workspace_ai_settings
SET reasoning_summary_mode = 'auto',
    updated_at = NOW()
WHERE reasoning_summary_mode = 'off';
