# Admin Readable Identities

Status: completed
Branch: `fix/admin-readable-identities`
Consumer: `platform-admin-console`

## Goal

Add governance-safe readable labels to the existing platform-admin workspace
and audit responses without removing immutable IDs or changing authorization.

## Constraints

- Preserve every `/admin/v1` route, scope, query, mutation, and pagination
  shape.
- Add only optional response fields.
- Resolve workspace creators from the authoritative `users` table.
- Resolve audit workspace names at read time so historical records keep their
  immutable workspace IDs.
- Do not expose tenant operational data or unrestricted audit metadata.

## Decision Log

- Workspace responses add optional `createdByDisplayName` and
  `createdByEmail`; `createdBy` remains the immutable user ID.
- Admin-audit responses add optional `workspaceName`; `workspaceId` remains the
  immutable filter and correlation value.
- Both additions use `LEFT JOIN` so missing identity rows cannot hide a
  workspace or audit event.

## Validation Log

- `NODE_ENV=test node --import tsx --test --test-concurrency=1 test/admin-readable-identities.test.ts`: passed (1 test).
- Relevant admin-security and readable-identity tests: passed (16 tests).
- `npm run typecheck`: passed.
- `npm run style:check`: passed.
- `npm run contracts:check`: passed.
- `npm run openapi:check`: passed (158 public paths, 174 public schemas, 28 admin paths, and 27 admin schemas).
- The full `npm run validate` reached unrelated database-backed suites but could
  not connect to PostgreSQL on host port 5432 (`ECONNREFUSED`). The local
  deployment intentionally keeps its PostgreSQL port inside Docker; affected
  repository, contract, and API checks passed.
- Rebuilt the local stack with `task local-up`; the control plane is healthy and
  a live repository read returned `Dev User` as the creator label and workspace
  names for all current workspace audit events.

## Completion Criteria

- Focused repository mapping tests cover readable labels and fallbacks.
- OpenAPI and producer contract manifests include the optional fields.
- Type, contract, and repository validation pass.
