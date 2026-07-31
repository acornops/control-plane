ALTER TABLE kubernetes_target_settings
  ADD COLUMN rbac_additions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN rbac_additions_source_version integer NOT NULL DEFAULT 0,
  ADD COLUMN rbac_additions_content_hash text NOT NULL DEFAULT '';

ALTER TABLE kubernetes_target_settings
  ADD CONSTRAINT kubernetes_target_settings_rbac_additions_array
  CHECK (jsonb_typeof(rbac_additions) = 'array');

ALTER TABLE kubernetes_target_settings
  ADD CONSTRAINT kubernetes_target_settings_rbac_additions_source_version_nonnegative
  CHECK (rbac_additions_source_version >= 0);
