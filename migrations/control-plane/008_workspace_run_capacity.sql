CREATE TABLE workspace_run_reservations (
  run_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pool text NOT NULL CHECK (pool IN ('chat','agent','workflow','autoTriage','insights')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','executing','parked','settling','settled')),
  owner_id text,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_expires_at timestamptz,
  executing_until timestamptz,
  eligible_at timestamptz NOT NULL DEFAULT now(),
  queue_expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_run_reservations_live ON workspace_run_reservations(workspace_id,pool,state) WHERE settled_at IS NULL;
CREATE TABLE workspace_run_operations (
  run_id text NOT NULL REFERENCES workspace_run_reservations(run_id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  operation_id text NOT NULL,
  owner_id text NOT NULL,
  deadline timestamptz NOT NULL,
  finished_at timestamptz,
  PRIMARY KEY(run_id,generation,operation_id)
);
CREATE INDEX workspace_run_operations_live ON workspace_run_operations(run_id,deadline) WHERE finished_at IS NULL;
CREATE TABLE workspace_lifecycle_outbox (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE workflow_dependency_continuations (
  run_id text PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  state jsonb NOT NULL CHECK (jsonb_typeof(state)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE target_auto_triage_jobs ADD COLUMN reserved_run_id text;
ALTER TABLE target_insights_checkpoint_jobs ADD COLUMN capacity_run_id text;
ALTER TABLE automation_dispatch_outbox DROP CONSTRAINT automation_dispatch_outbox_source_type_check;
ALTER TABLE automation_dispatch_outbox ADD CONSTRAINT automation_dispatch_outbox_source_type_check CHECK(source_type IN ('workflow','conversation'));
