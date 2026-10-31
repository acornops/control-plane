# Issue observation retention implementation plan

Goal: bound repetitive target issue history while preserving current issue state,
distinct evidence sources, lifecycle transitions, and existing API payloads.

Approved scope: 30-day configurable retention, hourly unchanged-history samples,
immediate first/reopened/changed-condition evidence, bounded cleanup. Agent
reporting, inventory replacement, and customer database cleanup are out of scope.

## Design

- Store a last-history-write time and evidence signature on each existing issue.
  The signature covers the set of source/object/container identities, severity,
  and reason. Ignore timestamps, text containing counters, restart counts and age.
  Keep full evidence in sampled observations and update current issue evidence
  and occurrence counts on every snapshot. New or reopened issues always record.
- Use the existing target transaction/row lock to serialize ingestion. Use the
  database clock for the hourly decision. Existing issues sample once after upgrade.
- Add one forward migration: two nullable issue columns and an observation
  `(created_at, id)` retention index. No historic payload rewrite/backfill.
- Default `TARGET_ISSUE_OBSERVATION_RETENTION_DAYS=30`. Purge by server-created
  timestamp in 500-row batches, at most 20 batches per sweep, each with a 5-second
  statement timeout. Skip locked rows. Keep live issue rows and latest evidence.
- Explain migration locking/headroom and throttled backlog cleanup in operations
  documentation. Normal vacuum makes space reusable; it does not promise file shrinkage.

## Tasks and validation

- [x] Add PostgreSQL regression coverage for duplicate observations with changing
  counters/timestamps, distinct sources, source ordering, meaningful condition
  changes, reopening, hourly sampling, future agent clocks, and current-state updates.
  Run red, implement sampling, rerun green.
- [x] Add expiry/batch/lock coverage and bounded-worker/failure-isolation tests.
  Run red, implement retention/configuration/index, rerun green.
- [x] Run a large-history PostgreSQL cleanup/index check and complete migration
  upgrade checks plus `npm run validate` with isolated PostgreSQL/Redis.
- [x] Review the complete diff independently, resolve material findings, move
  this plan to completed, and commit only the scoped changes.

## Review focus

No per-snapshot history scans; no loss of distinct evidence streams; significant
changes survive sampling; agent timestamps cannot control retention/sampling;
cleanup does not remove current issues or monopolize other retention work;
migration rollout accounts for a large existing table and transactional indexes.

## Evidence

- Baseline: 15 relevant tests passed at `cecdcdb`; isolated existing worktree
  reused on `fix/issue-observation-retention`. Unrelated working-copy drafts preserved.
- Sampling RED: 4 of 6 PostgreSQL regression cases failed on the old implementation
  (61 repeated records instead of 1, repeated sources, future clocks, concurrency).
  GREEN: all cases passed after sampling. Reopening and severity-change cases
  passed both before and after the change.
- Retention RED: the sweep omitted observation cleanup, and the repository purge
  did not exist. GREEN: cutoff, batch size, locked rows, worker cap, early exit,
  failure isolation and default retention checks pass. VM and Kubernetes evidence
  streams are both covered.
- Populated upgrade: applied migrations 001–012, inserted 100,000 observations,
  then applied the observation migration (renumbered to 014 during main integration).
  All 100,000 payloads survived unchanged; PostgreSQL selected the
  new index for the 500-row candidate query; cleanup removed exactly 500 rows and
  preserved the complete current issue record.
- First full run: 1,529 tests and SQL migration checks passed. Harness file-size
  checks required extracting observation helpers and five related configuration
  fields into small modules. Existing configuration defaults are unchanged.
- Added VM regression fixture initially omitted required creation/update timestamps;
  corrected the fixture and reran focused tests successfully before the final suite.
- Independent read-only review found no blocking findings. Its migration-locking
  documentation finding is addressed: issue reads/writes also block during index
  creation. Final manual review includes the helper extraction and VM coverage.
- No customer cleanup, full-stack deployment, or agent binaries were changed or
  exercised. API/authentication and agent transport contracts are unchanged.

- Final validation: `npm run validate` ran all 1,530 tests successfully, plus
  type/style, SQL migration, authorization, membership and run-event checks. It
  stopped at a static contract assertion that still read the old config location.
  After pointing that assertion at `src/config-retention.ts`, the remaining
  `npm run contracts:check`, `npm run openapi:check`, `npm run harness:check` and
  `npm run build` all passed. No runtime code changed after the passing full suite.
- Focused final command: `node --import tsx --test --test-concurrency=1
  test/target-issue-observation-history-postgres.test.ts test/conversation-retention.test.ts`
  passed all 16 tests. Database runs used `NODE_ENV=test` and matching `DATABASE_URL`
  and `CONTROL_PLANE_TEST_DATABASE_URL` pointing at an isolated PostgreSQL 16 test
  database; migration SQL checks used `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL`;
  the full suite used an isolated Redis instance via `REDIS_URL`.
- `git diff --check` passed. No deferred review findings. The migration-lock note
  is corrected; the inventory-write optimization remains the approved follow-up.
