CREATE TABLE workspace_capacity_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  active boolean NOT NULL DEFAULT false,
  catalog_hash text,
  activated_at timestamptz,
  verified_at timestamptz,
  CHECK (NOT active OR catalog_hash IS NOT NULL)
);
INSERT INTO workspace_capacity_rollout(singleton) VALUES(true);
