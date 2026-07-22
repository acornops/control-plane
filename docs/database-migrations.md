# Control Plane Database Migrations

The control-plane Postgres schema is owned by the greenfield SQL baseline at
`migrations/control-plane/001_initial_schema.sql`. The baseline creates the
complete current schema directly; pre-release upgrade and backfill paths are not
supported.
Application startup does not create or alter application tables. It verifies
that every checked-out migration has been applied with the expected checksum
and fails fast when the database is behind or has drifted.

## Commands

```bash
npm run db:migrate
npm run db:status
npm run db:check
```

All commands read `DATABASE_URL`. `CONTROL_PLANE_MIGRATIONS_DIR` can point at a
non-default migration directory for tests or packaging checks.

## Greenfield schema epoch

This schema epoch deliberately does not support in-place upgrades from any
pre-release database. Tear down and recreate the database before deploying this
version matrix. Future released migrations must be additive and immutable, but
there is no historical checksum manifest for the greenfield baseline.

The Docker deployment tracks run the `control-plane-init` one-shot service
before bringing up the control-plane application container. Use `task
local-reset` only for disposable local data.

## Validation

`npm run migrations:check` verifies that startup remains migration-only, checks
that exactly one baseline exists, and verifies repository-local deployment wiring.
If the sibling `../acornops-deployment` checkout is present, it also verifies
the deployment-repo compose and startup wiring. When
`CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` points to a disposable Postgres
database, the same check applies the baseline in isolation and introspects its
tables, columns, indexes, foreign keys, and check constraints.

Postgres-backed controller tests additionally require `NODE_ENV=test` and an
explicit `CONTROL_PLANE_TEST_DATABASE_URL` whose database name contains
`test`. `DATABASE_URL` must match it. The guard prevents test fixture resets
from targeting a development or production database.
