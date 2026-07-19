-- Workflow V2 schedules are user-owned. Service identities remain valid for
-- other automation triggers, but schedules are reassigned to their creator.

ALTER TABLE workflow_schedules
  DROP CONSTRAINT IF EXISTS workflow_schedules_principal_check;

UPDATE workflow_schedules AS schedule
SET principal = jsonb_build_object('type', 'user', 'id', schedule.created_by->>'userId'),
    status = CASE
      WHEN EXISTS (
        SELECT 1 FROM workspace_memberships AS membership
        WHERE membership.workspace_id = schedule.workspace_id
          AND membership.user_id = schedule.created_by->>'userId'
      ) THEN schedule.status
      ELSE 'paused'
    END,
    last_error = CASE
      WHEN EXISTS (
        SELECT 1 FROM workspace_memberships AS membership
        WHERE membership.workspace_id = schedule.workspace_id
          AND membership.user_id = schedule.created_by->>'userId'
      ) THEN schedule.last_error
      ELSE 'Schedule paused during user-principal migration because its creator is no longer an authorized workspace member.'
    END,
    next_run_at = CASE
      WHEN EXISTS (
        SELECT 1 FROM workspace_memberships AS membership
        WHERE membership.workspace_id = schedule.workspace_id
          AND membership.user_id = schedule.created_by->>'userId'
      ) THEN schedule.next_run_at
      ELSE NULL
    END,
    lease_owner = CASE WHEN EXISTS (
      SELECT 1 FROM workspace_memberships AS membership
      WHERE membership.workspace_id = schedule.workspace_id
        AND membership.user_id = schedule.created_by->>'userId'
    ) THEN schedule.lease_owner ELSE NULL END,
    lease_expires_at = CASE WHEN EXISTS (
      SELECT 1 FROM workspace_memberships AS membership
      WHERE membership.workspace_id = schedule.workspace_id
        AND membership.user_id = schedule.created_by->>'userId'
    ) THEN schedule.lease_expires_at ELSE NULL END,
    updated_at = NOW()
WHERE schedule.principal IS NULL OR schedule.principal->>'type' <> 'user';

ALTER TABLE workflow_schedules
  ALTER COLUMN principal SET NOT NULL,
  ADD CONSTRAINT workflow_schedules_principal_check CHECK (
    jsonb_typeof(principal) = 'object'
    AND principal->>'type' = 'user'
    AND COALESCE(principal->>'id', '') <> ''
  );

COMMENT ON COLUMN workflow_schedules.principal IS
  'Authenticated user principal. Service identities are not valid for workflow schedules.';
