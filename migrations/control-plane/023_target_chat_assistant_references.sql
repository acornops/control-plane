ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS assistant_references JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_assistant_references_array;

ALTER TABLE runs
  ADD CONSTRAINT runs_assistant_references_array
  CHECK (jsonb_typeof(assistant_references) = 'array');
