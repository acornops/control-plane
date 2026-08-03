# Permission Mode Forward Migration

## Goal

Ship the Kubernetes target permission-mode persistence change without changing
the checksum of the applied `001` migration, losing existing overrides, or
making rollback to the previous control-plane binary unsafe.

## Constraints

- Keep `001_initial_schema.sql` byte-for-byte compatible with databases that
  have already recorded it.
- Add the canonical enum column through an ordered forward migration.
- Backfill `true` as `ask_before_changes`, `false` as
  `auto_allowed_changes`, and preserve `NULL` as the deployment default.
- Retain and synchronize the legacy boolean for mixed-version rollout and
  rollback. `read_only` projects conservatively to legacy `true`.
- Fail on unexpected schema state instead of silently accepting drift.

## Decision log

- Use `002_target_permission_mode.sql`; the existing migration runner already
  applies ordered SQL files transactionally under an advisory lock.
- Keep both persistence columns during the compatibility window and install a
  trigger that synchronizes writes from either old or new application code.
- Make the new repository dual-read and dual-write so compatibility is explicit
  at the application boundary as well as protected in Postgres.
- Replace the greenfield-only validation rule with an immutable-baseline check
  plus fresh-install and upgrade-path assertions.

## Validation log

- `npm run migrations:check`: static migration-chain checks passed and verified
  the immutable `001` checksum.
- `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL=... npm run migrations:check`:
  passed against isolated Postgres, including legacy backfill, both write
  directions for inserts and updates, override clearing, final schema,
  constraint, function, and trigger introspection.
- `npm run db:migrate`, `npm run db:check`, then `npm run db:migrate` against a
  clean temporary database: applied `001` and `002`, reported current, and
  confirmed a repeat migration is a no-op.
- Focused permission, cluster controller, repository, confirmation, and target
  tool tests passed.
- Full `npm run validate` passed against isolated Postgres after removing live
  development-service/configuration leakage from the test process: 1,101 tests,
  typecheck, style, SQL upgrade checks, authorization, membership, run-event,
  contracts, OpenAPI, harness, and build.
- The final legacy/canonical mapper regression test passed after it was added;
  `npm run typecheck`, static migration checks, and `git diff --check` passed
  again.
- Workspace `node scripts/harness/check-platform-contracts.mjs` passed.

## Completion criteria

- Existing `001` checksum is unchanged.
- Migration checks verify backfill, bidirectional synchronization, enum
  validation, and final schema shape.
- Targeted repository/policy tests, typecheck, contract checks, and the
  repository validation entrypoint are run or their environmental blocker is
  recorded.

All completion criteria are satisfied.
