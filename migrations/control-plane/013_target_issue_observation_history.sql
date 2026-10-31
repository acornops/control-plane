ALTER TABLE target_issues
  ADD COLUMN last_observation_at timestamptz,
  ADD COLUMN observation_signature text;

CREATE INDEX idx_target_issue_observations_created_at
  ON target_issue_observations (created_at, id);
