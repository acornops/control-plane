CREATE TABLE IF NOT EXISTS workspace_audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  category TEXT NOT NULL,
  event_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_user_id TEXT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NULL,
  object_name TEXT NULL,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_audit_events_category_check
    CHECK (category IN ('membership', 'workspace', 'target', 'session', 'run', 'approval', 'mcp', 'tool')),
  CONSTRAINT workspace_audit_events_operation_check
    CHECK (operation IN ('read', 'write')),
  CONSTRAINT workspace_audit_events_actor_type_check
    CHECK (actor_type IN ('user', 'system')),
  CONSTRAINT workspace_audit_events_user_actor_check
    CHECK (
      (actor_type = 'system' AND actor_user_id IS NULL)
      OR (actor_type = 'user' AND actor_user_id IS NOT NULL)
    ),
  CONSTRAINT workspace_audit_events_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_workspace_occurred
  ON workspace_audit_events (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_workspace_type
  ON workspace_audit_events (workspace_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_workspace_category
  ON workspace_audit_events (workspace_id, category, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_events_occurred
  ON workspace_audit_events (occurred_at ASC, id ASC);

INSERT INTO workspace_audit_events (
  id,
  workspace_id,
  category,
  event_type,
  operation,
  actor_type,
  actor_user_id,
  object_type,
  object_id,
  object_name,
  summary,
  metadata,
  occurred_at
)
SELECT
  id,
  workspace_id,
  'membership',
  CASE action
    WHEN 'member_added' THEN 'workspace.member.added.v1'
    WHEN 'member_role_updated' THEN 'workspace.member.role_updated.v1'
    WHEN 'member_removed' THEN 'workspace.member.removed.v1'
    ELSE 'workspace.member.changed.v1'
  END,
  'write',
  'user',
  actor_user_id,
  'member',
  target_user_id,
  NULL,
  CASE action
    WHEN 'member_added' THEN 'Workspace member added'
    WHEN 'member_role_updated' THEN 'Workspace member role updated'
    WHEN 'member_removed' THEN 'Workspace member removed'
    ELSE 'Workspace membership changed'
  END,
  jsonb_build_object(
    'previousRole', previous_role,
    'nextRole', next_role,
    'legacyAction', action
  ),
  created_at
FROM workspace_membership_audit
ON CONFLICT (id) DO NOTHING;
