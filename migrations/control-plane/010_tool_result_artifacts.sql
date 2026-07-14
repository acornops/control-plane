CREATE TABLE IF NOT EXISTS run_tool_result_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  encoding TEXT NOT NULL,
  uncompressed_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  payload BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT ck_run_tool_result_artifacts_content_type
    CHECK (content_type IN ('application/json', 'text/plain')),
  CONSTRAINT ck_run_tool_result_artifacts_encoding
    CHECK (encoding = 'gzip'),
  CONSTRAINT ck_run_tool_result_artifacts_identity
    CHECK (LENGTH(call_id) BETWEEN 1 AND 256 AND LENGTH(tool_name) BETWEEN 1 AND 128),
  CONSTRAINT ck_run_tool_result_artifacts_sha256
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_run_tool_result_artifacts_sizes
    CHECK (uncompressed_bytes >= 0 AND uncompressed_bytes <= 2097152 AND compressed_bytes > 0),
  CONSTRAINT ck_run_tool_result_artifacts_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT fk_run_tool_result_artifacts_run
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  CONSTRAINT uq_run_tool_result_artifacts_call UNIQUE (run_id, call_id)
);

CREATE INDEX IF NOT EXISTS idx_run_tool_result_artifacts_expiry
  ON run_tool_result_artifacts (expires_at);
