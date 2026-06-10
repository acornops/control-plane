ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS llm_provider TEXT NOT NULL DEFAULT 'gemini'
    CHECK (llm_provider IN ('openai', 'anthropic', 'gemini')),
  ADD COLUMN IF NOT EXISTS llm_model TEXT NOT NULL DEFAULT 'gemini-2.0-flash';
