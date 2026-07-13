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

## Additive Migration Policy

Do not rewrite an applied migration. Add a new numbered forward migration and
keep runtime rollback independent from schema rollback. Automation rollout can
be stopped with `AUTOMATION_RUNTIME_MODE=off`; its additive tables and columns
remain in place for a later recovery or forward deployment.

The Docker deployment tracks include a `control-plane-init` one-shot service.
`task local-up` and `task prod-up` run this service before bringing up the
control-plane application container.

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
