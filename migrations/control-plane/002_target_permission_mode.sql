-- Add the canonical target permission mode without invalidating the applied
-- greenfield baseline. Keep the legacy boolean synchronized for rolling
-- upgrades and rollback until every deployed control plane uses the enum.

ALTER TABLE kubernetes_target_settings
  ADD COLUMN permission_mode_override text;

ALTER TABLE kubernetes_target_settings
  ADD CONSTRAINT kubernetes_target_settings_permission_mode_check
  CHECK (
    permission_mode_override IS NULL
    OR permission_mode_override = ANY (
      ARRAY[
        'read_only'::text,
        'ask_before_changes'::text,
        'auto_allowed_changes'::text
      ]
    )
  );

UPDATE kubernetes_target_settings
SET permission_mode_override = CASE write_confirmation_required_override
  WHEN true THEN 'ask_before_changes'
  WHEN false THEN 'auto_allowed_changes'
  ELSE NULL
END
WHERE write_confirmation_required_override IS NOT NULL;

CREATE FUNCTION sync_kubernetes_target_permission_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.permission_mode_override IS NOT NULL THEN
      NEW.write_confirmation_required_override :=
        NEW.permission_mode_override <> 'auto_allowed_changes';
    ELSIF NEW.write_confirmation_required_override IS NOT NULL THEN
      NEW.permission_mode_override := CASE NEW.write_confirmation_required_override
        WHEN true THEN 'ask_before_changes'
        ELSE 'auto_allowed_changes'
      END;
    END IF;
  ELSIF NEW.permission_mode_override IS DISTINCT FROM OLD.permission_mode_override THEN
    NEW.write_confirmation_required_override := CASE NEW.permission_mode_override
      WHEN 'read_only' THEN true
      WHEN 'ask_before_changes' THEN true
      WHEN 'auto_allowed_changes' THEN false
      ELSE NULL
    END;
  ELSIF NEW.write_confirmation_required_override IS DISTINCT FROM OLD.write_confirmation_required_override THEN
    NEW.permission_mode_override := CASE NEW.write_confirmation_required_override
      WHEN true THEN 'ask_before_changes'
      WHEN false THEN 'auto_allowed_changes'
      ELSE NULL
    END;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER kubernetes_target_settings_permission_mode_sync
BEFORE INSERT OR UPDATE OF permission_mode_override, write_confirmation_required_override
ON kubernetes_target_settings
FOR EACH ROW
EXECUTE FUNCTION sync_kubernetes_target_permission_mode();
