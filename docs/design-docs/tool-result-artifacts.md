# Tool Result Artifacts

The control plane stores complete redacted tool results separately from conversation evidence. Run events contain compact model context and optional artifact metadata only; `tool_call_completed` uses a strict field allowlist and independently enforces the 12 KiB model-context ceiling, so artifact payloads never enter SSE or replay streams.

## Storage lifecycle

The internal execution endpoint accepts artifacts only from the authenticated execution engine. The service enforces the 2 MiB uncompressed ceiling before and after defense-in-depth redaction—including credential-bearing URI userinfo, access-key assignments, and quoted credentials—canonicalizes JSON (or preserves plain text), hashes the redacted bytes with SHA-256, gzip-compresses them, and stores them in `run_tool_result_artifacts`.

Artifacts expire after `TOOL_RESULT_ARTIFACT_RETENTION_DAYS` (seven days by default). Conversation evidence follows the separate conversation retention policy. Retention sweeps delete artifacts in bounded batches, and deleting a run cascades to its artifacts.

`(run_id, call_id)` is idempotent. Repeating the same result and metadata returns the original artifact without extending its lifetime. Reusing a call ID with different bytes, tool identity, content type, or encoding is rejected instead of replacing evidence.

## Access boundary

The public download route verifies the run, workspace membership, and `read_workspace_data` capability. Missing, expired, cross-workspace, and unauthorized artifacts all return the same 404 response. Successful reads set `Cache-Control: no-store` and record `tool.result.read.v1` in the workspace audit log before returning the bounded decompressed payload.

Artifact upload failure does not fail diagnosis. The execution engine records `artifactUnavailable`; operators use artifact lifecycle metrics and alerts to investigate storage failures.

The authenticated Agent WebSocket accepts a bounded 3 MiB transport envelope. This is deliberately larger than the 2 MiB complete-result ceiling so the result, 12 KiB model projection, and MCP routing metadata can travel together without weakening the stored artifact limit.
