ALTER TABLE workspaces ADD COLUMN policy_version bigint NOT NULL DEFAULT 0 CHECK (policy_version >= 0);
CREATE TABLE workspace_suspension_holds (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('admin', 'external')),
  public_reason text CHECK (public_reason IS NULL OR length(public_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, source)
);
INSERT INTO workspace_suspension_holds (workspace_id, source, created_at)
SELECT id, 'admin', COALESCE(suspended_at, NOW()) FROM workspaces WHERE lifecycle_status = 'suspended';
UPDATE workspaces SET suspended_at = NOW() WHERE lifecycle_status = 'suspended' AND suspended_at IS NULL;
CREATE TABLE workspace_policy_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, request_id)
);
CREATE TABLE workspace_plan_definitions (
  plan_key text PRIMARY KEY,
  limits_hash text NOT NULL CHECK (limits_hash ~ '^[a-f0-9]{64}$')
);
