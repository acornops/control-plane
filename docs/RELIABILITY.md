# Control Plane Reliability

## Failure Modes

- OIDC or session misconfiguration blocks user access.
- Postgres or Redis degradation impacts state or stream replay.
- Redis degradation also affects control-plane HA because it coordinates agent ownership, cross-pod command routing, live run event fanout, and renewed scheduler leases.
- Pending or checksum-mismatched Postgres migrations block startup so schema/code drift is explicit.
- Execution-engine dispatch or callback failures stall runs.
- Agent disconnects make cluster state stale.
- Pending write approvals can pause runs in `waiting_for_approval`; expiry or a user decision must redispatch the stored continuation.
- llm-gateway admin sync failures create tool-catalog drift.
- If `PERSIST_RUN_EVENTS` is disabled outside local development, control-plane restarts lose trace replay history.

## Required Validation

- Run `npm run validate` for every substantive change.
- Run `npm run db:status` or `npm run db:check` before starting against an existing database after schema changes.
- Use the integration compose profile when changing execution-engine, llm-gateway, or auth-facing behavior.
- Preserve deterministic run event ordering and terminal run states.
- Preserve durable write-approval behavior: approval creation stores continuation and `waiting_for_approval` atomically, and decisions resume through backend redispatch.
- Keep browser-facing snapshot resource, finding, investigation, and summary shapes explicit in contracts; raw snapshot history remains internal storage for metrics history and diagnostics.
- Run event replay must read persisted `run_events` before live SSE fanout when persistence is enabled.
- Multi-pod deployments must keep unique `CONTROL_PLANE_INSTANCE_ID` values and a shared `REDIS_URL`.

## Recovery Expectations

- Prefer explicit contract changes and idempotent retries.
- During the pre-release phase, keep the schema baseline aligned with the direct desired schema and reset disposable databases when local state was created from an older baseline.
- Capture new failure patterns in contract docs or structural checks.
- When behavior is degraded but recoverable, prefer explicit errors over silent fallback.
- Production defaults persist run events in Postgres. Retention follows conversation retention because run events cascade with deleted runs and sessions.
- The internal run event cursor is the source of truth for resumed execution sequencing; it returns the latest replayable sequence from persisted events or the local runtime replay buffer when persistence is disabled for development.
- Write approvals are backend-enforced before tool execution. Frontend and bot cards only submit decisions; control plane enforces user permission and execution-engine resumes from Postgres continuation with fresh bootstrap credentials.
