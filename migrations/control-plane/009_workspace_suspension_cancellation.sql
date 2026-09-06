CREATE FUNCTION queue_workspace_suspension_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_status='suspended' AND OLD.lifecycle_status IS DISTINCT FROM NEW.lifecycle_status THEN
    INSERT INTO workspace_lifecycle_outbox(workspace_id,requested_at,completed_at)
    VALUES(NEW.id,clock_timestamp(),NULL)
    ON CONFLICT(workspace_id) DO UPDATE SET requested_at=EXCLUDED.requested_at,completed_at=NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_suspension_cancellation AFTER UPDATE OF lifecycle_status ON workspaces
FOR EACH ROW EXECUTE FUNCTION queue_workspace_suspension_cancellation();
INSERT INTO workspace_lifecycle_outbox(workspace_id,requested_at)
SELECT id,COALESCE(suspended_at,now()) FROM workspaces WHERE lifecycle_status='suspended';
