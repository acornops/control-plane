ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS request_actor_type TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS request_external_integration_link_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS request_external_integration_client_id TEXT NULL;

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_request_actor_type_check,
  ADD CONSTRAINT runs_request_actor_type_check
    CHECK (request_actor_type IN ('user', 'external_integration'));

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_request_actor_provenance_check,
  ADD CONSTRAINT runs_request_actor_provenance_check
    CHECK (
      (
        request_actor_type = 'user'
        AND request_external_integration_link_id IS NULL
        AND request_external_integration_client_id IS NULL
      )
      OR
      (
        request_actor_type = 'external_integration'
        AND request_external_integration_link_id IS NOT NULL
        AND request_external_integration_client_id IS NOT NULL
      )
    );

CREATE INDEX IF NOT EXISTS idx_runs_external_integration_origin
  ON runs (request_external_integration_link_id, requested_at DESC)
  WHERE request_actor_type = 'external_integration';
