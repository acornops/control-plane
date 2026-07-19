ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_workspaces_lifecycle_status'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT ck_workspaces_lifecycle_status
      CHECK (lifecycle_status IN ('active', 'suspended'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspaces_lifecycle_status
  ON workspaces (lifecycle_status);
