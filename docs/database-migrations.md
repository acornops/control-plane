# Control Plane Database Migrations

The control-plane Postgres schema is owned by SQL migrations in
`migrations/control-plane/`. During the pre-release phase, the repository keeps
a single baseline migration, `001_initial_schema.sql`, that represents the
direct desired schema for a fresh database. Application startup does not create
or alter application tables; it verifies that the checked-out migration baseline
has been applied and fails fast when the database is behind or the applied
checksum no longer matches the checked-out file.

## Commands

```bash
npm run db:migrate
npm run db:status
npm run db:check
```

All commands read `DATABASE_URL`. `CONTROL_PLANE_MIGRATIONS_DIR` can point at a
non-default migration directory for tests or packaging checks.

## Baseline Rewrite Policy

Pre-release schema changes may rewrite `001_initial_schema.sql` directly. This
intentionally does not preserve compatibility with disposable databases that
already applied an older baseline; reset the local database or rerun the
deployment init job against a fresh database before continuing.

After the product needs durable upgrade compatibility for shared, published, or
production-like environments, stop rewriting the baseline and add forward
migrations for schema changes so checksum verification remains meaningful across
installations.

The Docker deployment tracks include a `control-plane-init` one-shot service.
`task local-up` and `task prod-up` run this service before bringing up the
control-plane application container.

## Validation

`npm run migrations:check` verifies that startup remains migration-only, checks
the baseline migration shape, and verifies repository-local deployment wiring.
If the sibling `../acornops-deployment` checkout is present, it also verifies
the deployment-repo compose and startup wiring. When
`CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` points to a disposable Postgres
database, the same check also applies the baseline in an isolated empty schema.
