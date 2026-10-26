# Approval-resume reliability

Approved scope: accept approval requests from a dispatched execution even if its
asynchronous `run_started` event has not arrived. Keep queued, cancelling and
terminal runs rejected, and preserve exact write grants and human approval.

Coordinate with execution-engine's resume event/error correction and AgentV's
restart input descriptions on `fix/approval-resume-reliability`. The local central
plan is `acornops-workspace/change-sets/active/approval-resume-reliability.md`.
No API shape, migration, UI or deployment changes. Control Plane should ship
before/together with execution-engine. Implementation and independent review are
complete. Included in the coordinated experimental.41 release preparation;
deployment acceptance is recorded in the deployment repository's
`docs/exec-plans/completed/approval-resume-release.md` after rollout.

## Review correction

The independent review identified a delayed `run_started` event overwriting an
already persisted approval wait. A narrowly scoped atomic start transition now
accepts only queued, dispatching or running rows, preserves the original start
time and refreshes state after a refused transition. It never overwrites approval
waits, cancellation or terminal states. The normal human-decision path can still
persist its redispatch outbox entry. No execution permission was added.

## Validation (2026-10-27)

With Node 22 on `PATH`, using the disposable PostgreSQL/Redis services:

```sh
NODE_ENV=test DATABASE_URL=postgresql://acornops_test:acornops_test@127.0.0.1:55440/acornops_approval_test CONTROL_PLANE_TEST_DATABASE_URL=postgresql://acornops_test:acornops_test@127.0.0.1:55440/acornops_approval_test REDIS_URL=redis://127.0.0.1:56388/0 npm run validate
```

Passed: 1,382 tests, types, style, migration checks, authorization, membership,
event durability, contracts, public/admin OpenAPI, documentation checks and build.
The focused approval/cancellation suite passed 41 tests. The delayed-start tests
first reproduced six bad state transitions, then passed with the atomic guard.

`docker compose --env-file /dev/null -p acornops-approval-platform -f docker-compose.yml -f docker-compose.override.yml -f /tmp/acornops-approval-platform-compose.yaml --profile integration up -d --build`
passed with disposable, project-scoped volumes and no exposed ports. The temporary
override uses a distinct Control Plane image tag, disables development seeding and
leaves provider credentials unconfigured. Control Plane `/ready`, gateway
`/health` and execution-engine `/ready` all returned HTTP 200. A real engine-client
request for a nonexistent run returned the expected safe approval error from the
Control Plane 404; it created no run and executed no tool.

Workspace `node scripts/harness/check-platform-contracts.mjs` and all changed
repositories' `git diff --check` passed. The existing Management Console
`npm test -- src/features/targets/chat/hooks/chatRunTrace.test.ts` passed 11 tests;
no console files were changed by this task.

All test services and test-only volumes were removed after validation. Existing
local/demo stacks were untouched. A live VM restart and deployment were not
performed; a controlled approved restart remains a rollout smoke test. Broader
lifecycle behavior was not exhaustively audited in this focused review.
