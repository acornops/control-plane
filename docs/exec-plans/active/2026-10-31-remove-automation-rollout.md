# Remove automation rollout mode

Status: implemented, validated, and independently reviewed; merge/release pending.

## Scope

Remove the off/shadow/canary/on rollout selector and workspace allowlist. Normal
Workflow launches must dispatch without a hidden override. Preserve workspace
admission and dispatch pauses, readiness, authorization, approvals, drain handling,
claim fencing, and retries. Diagnostics expose admissionEnabled and dispatchEnabled
instead of mode and workspaceEnabled. Synchronize the console contract and public
OpenAPI snapshot. No schema or execution-engine protocol changes are needed.

Shared branch: `fix/remove-automation-rollout` in control-plane,
management-console, acornops-deployment, and docs-website. Merge the control plane
and mirrored contracts first, release it, then update deployment image pins before
merging the mode-free deployment templates. Do not deploy those templates with
the currently pinned control-plane `0.0.1-experimental.42` image.

## Verification

- Before implementation, the default launch, pause/reopen, and diagnostics
  regressions produced five expected failures.
- Focused PostgreSQL regressions passed: 35 tests across
  `automation-runtime-postgres`, `workflows-controller`, `dispatch-capacity-postgres`,
  and `workflow-dispatch-recovery-postgres`.
- `npm run validate` passed: 1,523 tests, type/style, migration-chain static
  checks, authz, membership, durable events, contracts, public/admin OpenAPI,
  harness, and build. Tests used dedicated PostgreSQL/Redis containers.
- Launch/diagnostics/pause tests also passed (10/10) with stale `off` and canary
  environment settings, confirming they no longer affect dispatch.
- `docker compose --profile integration up -d --build` passed under an isolated
  project with a test-only override removing published ports and seed data.
  Control-plane readiness and engine/gateway health each returned 200. Current
  migrations applied to a fresh database. SQL upgrade replay and live provider/
  agent workloads were not run; no schema or engine protocol changed.
- Workspace `node scripts/harness/check-platform-contracts.mjs` passed.
- One independent whole-change review found no actionable issues in rollout
  removal. The subsequent capacity repair is tracked below; the compatible
  runtime image is required before merging deployment configuration.

## Separate capacity-maintenance defect

`workspace-capacity-maintenance.ts` fails expired queued `workflow_runs` with
`EXECUTION_AUTHORITY_LOST` and settles capacity, but does not recompute
`workflow_executions.status`. The workflow summary can remain queued and block
resume after its underlying run has failed. A real-Postgres reproduction on
current code and the pinned release reproduced this with capacity enabled and
disabled, before and after dispatch acknowledgement. Repeated maintenance and
outbox ticks did not repair the summary.

The user subsequently authorized a [focused repair](2026-10-31-capacity-maintenance-status.md)
and merging the coordinated changes. The following describes the original defect.

This occurs after the queue deadline (600 seconds by default); it does not
explain a run staying queued immediately at launch. Removing the rollout mode
eliminates one source of undelivered work but does not repair this defect or old
records by itself. The focused repair adds transactional execution aggregation on
maintenance transitions, regression coverage, and bounded reconciliation of stale
summaries without redispatching failed work.
