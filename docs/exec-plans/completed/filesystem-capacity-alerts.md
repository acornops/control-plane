# Filesystem Capacity Inventory Consistency

## Goal and Scope

Keep VM inventory pressure badges consistent with AgentV's filesystem findings.
AgentV owns the filesystem eligibility policy; control-plane must not reapply
an independent 90% threshold to raw immutable-image measurements.

## Implementation

- Derive pressured mounts from non-info `FILESYSTEM_PRESSURE` snapshot findings.
- Preserve raw filesystem facts; absence of a finding means no pressure badge,
  not proof that the mount is healthy. Do not add type/path/device heuristics.
- Add repository persistence tests and update `docs/OPERATIONS.md`.
- No wire schema, manifest, permissions, dependencies, or migration changes.

## Validation

Use RED/GREEN repository tests, `npm run validate`, and the parent workspace
contract check. Confirm existing issue recovery/reconciliation tests still pass.

## Rollout / Rollback

Shares branch `fix/filesystem-capacity-alerts` with AgentV. Both changes are
compatible with the existing v2 snapshot, in either deployment order. Existing
AgentV installations need an upgrade to stop emitting image-capacity findings.
Subsequent snapshots update badges and reconcile old issues. Rollback can restore
the old false positives; no data migration or deletion is required.

## Completion — 2026-10-25

Implemented and validated locally on `fix/filesystem-capacity-alerts`. The initial
handoff left changes uncommitted, without a release or deployment. Independent
read-only review found no actionable issues.

Validation evidence:

- `NODE_ENV=test node --import tsx --test test/repository-virtual-machines.test.ts`:
  observed the new regression fail before the mapper changed (8 passed, 1 failed).
- `NODE_ENV=test node --import tsx --test test/repository-virtual-machines.test.ts test/target-issues.test.ts`:
  all 14 tests passed, including existing recovery, resolution, and reopening.
- `npm run db:migrate && npm run validate`: passed against disposable PostgreSQL
  16 and Redis 7 containers with `NODE_ENV=test`, matching `DATABASE_URL` and
  `CONTROL_PLANE_TEST_DATABASE_URL` for `acornops_filesystem_test`, and an isolated
  `REDIS_URL`. All 1,327 tests passed, no skips; type/style, migration-chain,
  authorization, membership, run-event, contract, OpenAPI, harness, and build
  checks passed. The initial run without a configured database failed; no code
  or tests were weakened to make it pass.
- Parent `node scripts/harness/check-platform-contracts.mjs`: passed.
- `git diff --check`: passed.

No migrations or UI components changed. The optional SQL upgrade matrix and
browser/live-VM acceptance were not run; the tests cover snapshot persistence
mapping, and all migrations were applied to the fresh test database. AgentV's
companion change passed its 95-test coverage run and package/bootstrap smoke.
Release and host upgrade remain separate actions.

## Release follow-up — 2026-10-25

The user subsequently authorized main integration, publication and an in-place
demo upgrade after another correctness review. Fresh independent source review
found no actionable issues, including compatibility, snapshot trimming and issue
reconciliation. Image `.38` is the proposed release; publication and rollout
evidence belongs to the deployment repository's `filesystem-capacity-release`
plan. No additional runtime change was required by this review.
