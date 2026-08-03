# Control Plane Database Migrations

The control-plane Postgres schema starts with the immutable baseline at
`migrations/control-plane/001_initial_schema.sql` and evolves through ordered
forward migrations in the same directory.
Application startup does not create or alter application tables. It verifies
that every migration has been applied with the expected checksum and fails fast
when the database has pending migrations or has drifted.

## Commands

```bash
npm run db:migrate
npm run db:status
npm run db:check
```

All commands read `DATABASE_URL`. `CONTROL_PLANE_MIGRATIONS_DIR` can point at a
non-default migration directory for tests or packaging checks.

## Forward migration policy

Applied migration files are immutable. Add schema and data changes as the next
zero-padded SQL migration; never edit `001_initial_schema.sql` or another file
whose checksum may already be recorded in `control_plane_schema_migrations`.
Each file runs transactionally under a Postgres advisory lock, and a failed
migration is rolled back without recording its version.

Migrations must preserve data and support the documented rollout order. When a
contract changes representation, use an expand/backfill/compatibility phase
before removing the old representation in a later release. Prefer explicit
failure on unexpected schema state over `IF NOT EXISTS`, which can hide drift.

The Docker deployment tracks run the `control-plane-init` one-shot service
before bringing up the control-plane application container. Existing databases
are upgraded in place. Use `task local-reset` only when intentionally discarding
disposable local data.

`002_target_permission_mode.sql` is the first forward migration. It adds and
backfills the canonical target permission enum while retaining the legacy
boolean. A compatibility trigger synchronizes both representations so the
previous and current control-plane binaries can coexist during rollout and the
application can be rolled back without losing policy updates.

`003_help_links_platform_setting.sql` expands the durable platform-setting key
constraint to permit `help_links`. Previous control-plane versions ignore the
new row, so the migration supports rolling upgrades and rollback.

## Validation

`npm run migrations:check` verifies that startup remains migration-only, checks
the immutable baseline checksum and required forward-migration behavior, and
verifies repository-local deployment wiring.
If the sibling `../acornops-deployment` checkout is present, it also verifies
the deployment-repo compose and startup wiring. When
`CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` points to a disposable Postgres
database, the same check applies the baseline, inserts legacy data, runs the
forward chain, verifies its backfill and mixed-version synchronization, and
introspects the final tables, columns, indexes, foreign keys, triggers, and check
constraints.

Postgres-backed controller tests additionally require `NODE_ENV=test` and an
explicit `CONTROL_PLANE_TEST_DATABASE_URL` whose database name contains
`test`. `DATABASE_URL` must match it. The guard prevents test fixture resets
from targeting a development or production database.
