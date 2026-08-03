# Admin User Last Login

## Goal

Add an optional `lastLoginAt` field to paginated platform-admin user summaries,
derived from existing password and federated-identity login timestamps.

## Constraints

- Do not add or alter any database schema, migration, or index.
- Keep the change additive and backward compatible.
- Return only the latest aggregate timestamp; expose no session or identity
  subject details.
- Avoid per-user database queries.

## Decisions

- Compute the maximum recorded login across password credentials and all OIDC
  identities in the existing list query.
- Keep the field optional when no login timestamp has been recorded.
- Preserve the existing `AdminUser` OpenAPI component identity and add only an
  optional property, avoiding generated-client type churn.

## Validation Results

- Focused repository and OpenAPI tests pass (7 tests).
- A rollback-only PostgreSQL probe confirms the latest password/OIDC timestamp
  wins and a user without recorded logins returns null.
- Typecheck, style, migration static and SQL introspection, authorization,
  membership, run-event, contract, OpenAPI, harness, and build checks pass.
- The full control-plane run passes 1,094 of 1,095 tests. The remaining failure
  is an unrelated existing Agent-tool preview expectation (`1` expected versus
  `4` built-in/read tools observed) and reproduces in isolation.
- The consumer contract check confirms the producer counterpart matches.

## Completion Criteria

- `GET /admin/v1/users` returns optional `lastLoginAt` without changing its
  route, filters, cursor, scope, existing fields, or OpenAPI component identity.
- No migration, database schema, or index changes.
- Producer and consumer contract evidence matches.
