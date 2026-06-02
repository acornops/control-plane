CREATE INDEX IF NOT EXISTS idx_workspaces_created_id
  ON workspaces (created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_role_user
  ON workspace_memberships (workspace_id, role, user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_status_created_id
  ON workspace_invitations (workspace_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_targets_workspace_type_status_created_id
  ON targets (workspace_id, target_type, status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_target_last_message_id
  ON sessions (workspace_id, target_id, last_message_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_session_created_id
  ON messages (session_id, created_at DESC, id DESC);
