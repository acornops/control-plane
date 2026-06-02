# Control Plane Database Migrations

The control-plane Postgres schema is owned by versioned SQL migrations in
`migrations/control-plane/`. Application startup does not create or alter
application tables; it verifies that all local migration files have been applied
and fails fast when the database is behind or a previously applied migration
checksum no longer matches the checked-out file.

## Commands

```bash
npm run db:migrate
npm run db:status
npm run db:check
```

All commands read `DATABASE_URL`. `CONTROL_PLANE_MIGRATIONS_DIR` can point at a
non-default migration directory for tests or packaging checks.

## Migration Rewrite Policy

Do not rewrite migration files that may have been applied in shared, published,
or production-like environments. Add a new migration for durable schema changes
so checksum verification remains meaningful across installations.

For disposable local development only, an unpublished migration can be rewritten
while iterating on a change. When that happens, reset the local database or rerun
the deployment init job against a fresh database before continuing.

The Docker deployment tracks include a `control-plane-init` one-shot service.
`task local-up` and `task prod-up` run this service before bringing up the
control-plane application container.

## Validation

`npm run migrations:check` verifies that startup remains migration-only, checks
the migration file sequence, and verifies repository-local deployment wiring. If
the sibling `../acornops-deployment` checkout is present, it also verifies the
deployment-repo compose and startup wiring. When
`CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` points to a disposable Postgres
database, the same check also applies migrations in an isolated empty schema.
