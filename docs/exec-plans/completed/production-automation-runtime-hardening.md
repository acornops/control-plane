# Production Automation Runtime Hardening

## Objective

Close the remaining code-level release gaps for the durable Agents and Workflows runtime: durable approval parity for standalone Agents and workflow tool writes, automation-specific diagnostics and telemetry, and Postgres-backed validation coverage.

## Scope

- Add an additive migration and repository for generic automation approvals and continuations.
- Keep existing target-run approval contracts compatible while resolving Agent and Workflow runs through the same internal and public routes.
- Gate direct Agent `always` policies before dispatch and dynamically gate write tools for Agents and Workflows.
- Expire automation approvals durably and fail closed on rejected, expired, or uncertain writes.
- Add automation dependency diagnostics separately from `/ready`.
- Instrument dispatch, scheduling, triggers, approvals, template readiness, reports, and terminal outcomes without recording sensitive bodies or tool arguments.
- Add focused Postgres integration coverage and restore the repository validation suite where feasible in this workspace.

## Constraints

- Preserve the shared branch `feat/production-agents-workflows` and unrelated workspace/AgentK changes.
- Postgres claims and transactions remain authoritative; Redis is only a contention optimization.
- Do not log prompts, chat bodies, tool arguments, webhook payloads, credentials, or report contents.
- Do not automatically retry a write after execution has started with an uncertain result.
- Keep migrations additive and rollback-safe through `AUTOMATION_RUNTIME_MODE=off`.

## Verification

- Migration rerun and database-current checks.
- Focused repository/controller tests for Agent pre-step approval, Agent/Workflow tool approval, expiry, and uncertain execution.
- Metrics and diagnostics tests.
- `npm run typecheck`, `npm run contracts:check`, `npm run harness:check`, `npm run validate`.
- Workspace platform-contract checks and change-set update.

## Status

- [x] Inspect current implementation and approval boundaries.
- [x] Implement durable automation approvals and callback enforcement.
- [x] Add diagnostics and telemetry.
- [x] Add/migrate Postgres-backed tests.
- [x] Complete validation and move this plan to `completed/`.

## Outcome

Standalone Agents and Workflow steps now use the same durable approval,
continuation, dispatch, callback, cancellation, and terminal-commit path. The
runtime exposes automation diagnostics and bounded, content-free metrics while
keeping `/ready` limited to Postgres and Redis correctness. System skills are
seeded transactionally for new workspaces and backfilled by migration `007`, so
catalog reads no longer mutate state.

The complete control-plane suite passed against an isolated Postgres database
and Redis database, including focused approval expiry and uncertain-write
coverage. Contract, OpenAPI, authorization, durability, migration, harness,
type, style, and build checks also passed. Infrastructure release gates that
require Helm, a three-replica Kubernetes environment, VM production deployment,
load generation, and the seven-day SLO burn-in remain tracked in the workspace
change-set rather than as unfinished code in this execution plan.
