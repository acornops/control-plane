CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  accepted_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_status
  ON workspace_invitations (workspace_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_role
  ON workspace_invitations (workspace_id, role);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email_status
  ON workspace_invitations (email, status, expires_at);
