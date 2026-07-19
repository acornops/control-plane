# Control Plane Database Migrations

The control-plane Postgres schema is owned by ordered SQL migrations in
`migrations/control-plane/`. `001_initial_schema.sql` is the original platform
baseline; later migrations add the Agent/Workflow catalog, durable automation
runtime, approvals, status constraints, and transactional system-skill seeding.
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

## Migration Immutability and Schema Epochs

Do not rewrite an applied migration. Released migration checksums are frozen in
`migrations/control-plane/released-checksums.json`; add a new numbered forward
migration instead. Workflow schema epoch 2 is a first-install or explicit-reset
cutover, not an additive or rolling upgrade. Run `npm run db:preflight` before
init or migration. When it reports `WORKFLOW_V2_DATABASE_RESET_REQUIRED`, back
up and explicitly drop/recreate the database; no migration or startup command
deletes incompatible V1 workflow records. A V1 rollback requires restoring the
backup and the complete pinned V1 image matrix.

The Docker deployment tracks include a `control-plane-preflight` one-shot
service before the `control-plane-init` service. `task local-up` and
`task prod-up` run preflight before bringing up the control-plane application
container. Use `task local-reset` only for disposable local data.

## Validation

`npm run migrations:check` verifies that startup remains migration-only, checks
the ordered migration shape, and verifies repository-local deployment wiring.
If the sibling `../acornops-deployment` checkout is present, it also verifies
the deployment-repo compose and startup wiring. When
`CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` points to a disposable Postgres
database, the same check applies the full ordered migration set in isolation.

Postgres-backed controller tests additionally require `NODE_ENV=test` and an
explicit `CONTROL_PLANE_TEST_DATABASE_URL` whose database name contains
`test`. `DATABASE_URL` must match it. The guard prevents test fixture resets
from targeting a development or production database.
