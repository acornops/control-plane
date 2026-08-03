-- Expand the durable platform-setting key catalog for configurable product
-- help destinations. Existing control-plane versions ignore unknown rows, so
-- this remains safe during rolling upgrades and rollback.

ALTER TABLE platform_setting_overrides
  DROP CONSTRAINT platform_setting_overrides_key_check;

ALTER TABLE platform_setting_overrides
  ADD CONSTRAINT platform_setting_overrides_key_check
  CHECK (
    key = ANY (
      ARRAY[
        'member_discovery'::text,
        'ai_policy'::text,
        'password_signup'::text,
        'user_sign_in_methods'::text,
        'help_links'::text,
        'kubernetes_rbac_additions'::text
      ]
    )
  );
