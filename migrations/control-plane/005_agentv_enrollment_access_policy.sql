ALTER TABLE agentv_enrollments
    ADD COLUMN access_policy jsonb NOT NULL
    DEFAULT '{"accessMode":"read_only","restartServices":[]}'::jsonb;

ALTER TABLE agentv_enrollments
    ALTER COLUMN access_policy DROP DEFAULT;
