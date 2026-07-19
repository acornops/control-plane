ALTER TABLE admin_audit_events
  ADD COLUMN IF NOT EXISTS admin_actor_issuer TEXT NULL,
  ADD COLUMN IF NOT EXISTS admin_actor_subject TEXT NULL,
  ADD COLUMN IF NOT EXISTS admin_actor_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS admin_actor_display_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS admin_actor_role TEXT NULL,
  ADD COLUMN IF NOT EXISTS admin_session_id_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS authentication_time TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS admin_audit_events_actor_idx
  ON admin_audit_events (admin_actor_issuer, admin_actor_subject, occurred_at DESC);

REVOKE UPDATE, DELETE ON admin_audit_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION prevent_admin_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_events_append_only ON admin_audit_events;
CREATE TRIGGER admin_audit_events_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_event_mutation();
