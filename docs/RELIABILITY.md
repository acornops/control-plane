# Control Plane Reliability

## Failure Modes

- OIDC or session misconfiguration blocks user access.
- Postgres or Redis degradation impacts state or stream replay.
- Redis degradation also affects control-plane HA because it coordinates agent ownership, cross-pod command routing, live run event fanout, and renewed scheduler leases.
- Pending or checksum-mismatched Postgres migrations block startup so schema/code drift is explicit.
- Execution-engine dispatch or callback failures stall runs.
- Agent disconnects make cluster state stale.
- Pending write approvals can pause runs in `waiting_for_approval`; decisions resume the stored continuation, while expiry fails the attempt without granting the capability.
- llm-gateway admin sync failures create tool-catalog drift.
- If `PERSIST_RUN_EVENTS` is disabled, control-plane restarts and bounded in-memory eviction lose trace replay history. Canonical local, staging, and production configurations keep it enabled; disable it only in isolated tests that do not validate traces.

## Required Validation

- Run `npm run validate` for every substantive change.
- Run `npm run db:status` or `npm run db:check` before starting against an existing database after schema changes.
- Use the integration compose profile when changing execution-engine, llm-gateway, or auth-facing behavior.
- Preserve deterministic run event ordering and terminal run states.
- Preserve durable write-approval behavior: approval creation stores continuation and `waiting_for_approval` atomically, and decisions resume through backend redispatch.
- Preserve the acknowledged-run boundary: Agent/Workflow run creation and its dispatch-outbox insert commit in one transaction before returning `202`.
- Preserve the admin membership audit boundary: an admin-initiated membership
  change, its protected Admin Audit success record, and its sanitized workspace
  audit record commit in one transaction. Any success-audit failure rolls back
  the membership change.
- Keep Postgres `FOR UPDATE SKIP LOCKED` claims authoritative for schedules, trigger deliveries, dispatch, and approval expiry. Redis leases may only reduce contention.
- Never retry a write after an uncertain execution result. Mark the attempt `needs_review` and require an authorized resume.
- Keep browser-facing snapshot resource, durable issue, summary, and metric-history shapes explicit in contracts; only the latest raw target snapshot is retained, while metrics use compact history samples.
- Run event replay must read persisted `run_events` before live SSE fanout when persistence is enabled.
- Target chat activity streams must replay persisted `chat_activity_events` before live SSE fanout when clients reconnect with `Last-Event-ID` or `?after=...`; fresh connects are live-only and should use recent activity/session reads for initial state.
- Multi-pod deployments must keep unique `CONTROL_PLANE_INSTANCE_ID` values and a shared `REDIS_URL`.

## Recovery Expectations

- Prefer explicit contract changes and idempotent retries.
- During the pre-release phase, keep the schema baseline aligned with the direct desired schema and reset disposable databases when local state was created from an older baseline.
- Capture new failure patterns in contract docs or structural checks.
- When behavior is degraded but recoverable, prefer explicit errors over silent fallback.
- Production defaults persist run events in Postgres. Retention follows conversation retention because run events cascade with deleted runs and sessions.
- Browser-facing target chat activity events are persisted in Postgres with durable resource IDs so session deletion remains replayable. They cascade with target deletion.
- The internal run event cursor is the source of truth for resumed execution sequencing; it returns the latest replayable sequence from persisted events or the local runtime replay buffer when persistence is disabled for development.
- Write approvals are backend-enforced before tool execution. Frontend and bot cards only submit decisions; control plane enforces user permission and execution-engine resumes from Postgres continuation with fresh bootstrap credentials.
- Workflow execution is deterministic and sequential. Each executable step snapshots exactly one active Agent, its version, the Workflow version, step scope, target binding, and idempotency key before dispatch.
- Incident reports retain versioned source plus provenance in Postgres. PDF bytes are rendered within resource limits for each authorized download and are never persisted.
