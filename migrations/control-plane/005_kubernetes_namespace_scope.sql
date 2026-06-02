ALTER TABLE kubernetes_target_settings
  ADD COLUMN IF NOT EXISTS namespace_include JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS namespace_exclude JSONB NOT NULL DEFAULT '[]'::jsonb;
