# Control Plane Database Migrations

The control-plane Postgres schema is owned by the greenfield SQL baseline at
`migrations/control-plane/001_initial_schema.sql`. The baseline creates the
complete current schema directly; pre-release upgrade and backfill paths are not
supported.
Application startup does not create or alter application tables. It verifies
that the single baseline has been applied with the expected checksum and fails
fast when the database is missing it or has drifted.

## Commands

```bash
npm run db:migrate
npm run db:status
npm run db:check
```

All commands read `DATABASE_URL`. `CONTROL_PLANE_MIGRATIONS_DIR` can point at a
non-default migration directory for tests or packaging checks.

## Greenfield schema policy

This application has not been released and does not support database upgrades.
`001_initial_schema.sql` is the complete current schema. Schema changes update
that file directly; adding a second SQL migration is rejected by validation.
Disposable local databases must be recreated after the baseline changes.

The Docker deployment tracks run the `control-plane-init` one-shot service
before bringing up the control-plane application container. Use `task
local-reset` only for disposable local data.

## Validation

`npm run migrations:check` verifies that startup remains migration-only, checks
that exactly one SQL file exists, and verifies repository-local deployment wiring.
If the sibling `../acornops-deployment` checkout is present, it also verifies
the deployment-repo compose and startup wiring. When
`CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` points to a disposable Postgres
database, the same check applies the baseline in isolation and introspects its
tables, columns, indexes, foreign keys, and check constraints.

Postgres-backed controller tests additionally require `NODE_ENV=test` and an
explicit `CONTROL_PLANE_TEST_DATABASE_URL` whose database name contains
`test`. `DATABASE_URL` must match it. The guard prevents test fixture resets
from targeting a development or production database.
