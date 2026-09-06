# Platform release hardening

## Integration — 2026-09-07

Implementation is complete. The user authorized fresh verification followed by
committing and pushing these changes directly to `main`. Earlier no-commit
statements below describe the initial implementation task, not this integration.
No deployment or production data mutation is authorized.

Fresh verification exposed a pre-existing suspension timestamp defect. The user
authorized its focused fix, recorded in [Execution admission fencing](execution-admission-fencing.md).
Full `npm run validate` now passes all 1,313 tests plus type/style, migration,
authorization, membership, run-event, contract, OpenAPI, harness and build checks.
Migrations 001–012 passed on disposable PostgreSQL 16. The exact +60-second
application-clock reproduction now passes. Independent review found no blocking
issues. Isolated two-control-plane/two-engine integration passed against engine
main `b8eb8dd464c725984d17073b67ca2808c667e6fb`; the user's separate engine
checkout was not changed. The initial probe against that checkout could not start
because it lacked the capacity module.

Validation used Node 24.2.0, not the Node 22 support floor. Full Compose startup was
not run against the user's existing stack; the isolated replica probe exercised
the changed execution boundary with disposable PostgreSQL and Redis instead.
Published image reconciliation and an actual production upgrade/backup rehearsal
remain release operations, including the documented legacy backfill prerequisite.

## Implementation record — 2026-09-06

Status: implemented and validated; awaiting integration. Branch: `fix/platform-release-hardening`.

## Scope and decisions

Fix the release audit's scheduling defects and the admin user directory's
workspace-filter query. Preserve existing route/payload shapes where possible;
new query filtering is additive. No deployment, commits, image publication, or
production data mutation is part of this task.

- Use bounded calendar-aware cron iteration instead of synchronous per-minute
  search. Keep numeric five-field syntax, with conventional restricted
  day-of-month/day-of-week OR semantics. Verify DST and leap-day behavior.
- Reject schedules without a future occurrence before enabled persistence;
  preview, creation, update, and dispatch must agree.
- Keep the public schedule-preview response shape and field errors. Management
  Console will consume that existing endpoint and preserve draft errors.
- Filter admin user membership at the producer instead of unbounded browser
  detail requests. Preserve governance-only projection and pagination.

## Execution and verification

- [x] Add failing cron/date/performance regressions; replace iteration and verify.
- [x] Add invalid/unrunnable create/update/preview persistence regressions.
- [x] Add bounded admin-filter query and authorization/pagination regressions.
- [x] Update scheduling and admin contract documentation with mirrored consumers.
- [x] Run targeted tests, `npm run validate`, SQL migration checks in disposable
  PostgreSQL, and parent cross-repository contract checks.
- [x] Record exact outcomes and remaining release-environment verification.

## Evidence — 2026-09-06

- `DATABASE_URL=<disposable PostgreSQL> CONTROL_PLANE_TEST_DATABASE_URL=<same>
  npm run validate`: passed; 1,307 tests, zero skipped, plus type/style,
  migration/authz/membership/run-event/contract/OpenAPI/harness checks and build.
  Runtime was Node 24.2.0, not the supported Node 22 floor.
- After final review cleanup, `npm run typecheck && npm run style:check` and
  `NODE_ENV=test DATABASE_URL=<test> CONTROL_PLANE_TEST_DATABASE_URL=<test>
  node --import tsx --test --test-concurrency=1 test/workflow-schedule-cron.test.ts
  test/workflow-schedules-approvals.test.ts test/workflow-schedule-mcp-readiness.test.ts`
  passed all 35 scheduling/readiness tests.
- A final numeric-boundary regression reproduced and fixed parser acceptance
  of steps outside JavaScript's safe integer range, matching the console guard.
  The 15-test cron suite plus type/style checks passed afterward.
- Cron regressions first reproduced the old step, OR, leap-day, malformed-field,
  summary and monthly-timezone performance failures. Calendar iteration uses
  pinned `cron-parser` 5.10.0 with a numeric-only dialect guard.
- Independent review found two additional issues; fixed both: atomic legacy
  NULL-next-run auto-pause cannot overwrite an operator repair, and leading-star
  day fields retain intersection semantics. Public parser date operations skip
  rejected local days; the bounded 400-year Gregorian horizon covers sparse
  leap-day weekday intersections. Fifteen cron tests cover these behaviors,
  DST transitions, century gaps, and bounded invalid-date handling.
- `npm run db:migrate`, `npm run db:check`, `npm run db:status`: passed on
  disposable PostgreSQL 16; migrations 001–012 applied and a repeat migrate was
  a no-op with matching checksums. This is not a representative backup rehearsal.
- The disposable PostgreSQL container and its generated volume were removed
  after verification; fixture data is reproducible. Existing local stack and
  production data were not touched.
- Admin regression uses transaction-local temporary tables: 1,000 users,
  137 literal workspace-name matches across six bounded pages, combined filters
  and query-bound cursors. No shared fixture tables or tenant data were changed.
- `npm run openapi:export`, `npm run contracts:check`, `npm run openapi:check`:
  passed. Generated public/admin documents are updated in docs-website. The
  initially stale hosted-capacity document was reconciled by fast-forwarding
  that clean checkout to its existing upstream revision, not by hiding a gate.
- Parent `node scripts/harness/check-platform-contracts.mjs`: passed.
- Documentation: cadence/preview contract, schedule rollout behavior, additive
  admin query, generated OpenAPI and public user guidance are aligned.
- Skipped: published-image verification, Node 22 runtime execution, production
  traffic, and upgrade/restore rehearsal with actual databases and secret-store
  configuration. No representative backup or final release artifacts supplied.

## Integration

Producer changes precede Management Console and Platform Admin Console consumers.
Deployment template/documentation changes do not select unpublished new tags.
The exact release matrix and representative upgrade rehearsal remain release
operator gates, separate from local source validation.
