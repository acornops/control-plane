ALTER TABLE platform_setting_overrides
  DROP CONSTRAINT platform_setting_overrides_key_check;

ALTER TABLE platform_setting_overrides
  ADD CONSTRAINT platform_setting_overrides_key_check
  CHECK ((key = ANY (ARRAY[
    'member_discovery'::text,
    'ai_policy'::text,
    'password_signup'::text,
    'user_sign_in_methods'::text,
    'kubernetes_rbac_additions'::text
  ])));
