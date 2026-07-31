# Mutation-Only Admin Audit

## Goal

Stop persisting protected Admin Audit events for read-only `/admin/v1`
operations while preserving audit coverage for authentication lifecycle events
and every privileged mutation attempt, outcome, and failure.

## Constraints

- Keep HTTP access logs for all admin requests.
- Keep append-only historical records; do not delete existing read events.
- Preserve mutation audit failure behavior and transaction-backed membership,
  setting, and workspace-default audit writes.
- Preserve the `/admin/v1/admin-audit-events` route, schema, filters, scopes,
  pagination, and response projection.

## Validation

- Focused mutation-only, member-search, and readable-identity tests passed.
- Typecheck, Google-style, migration static checks, authorization, membership,
  run-event durability, contracts, OpenAPI, harness, build, and the workspace
  mirror check passed.
- The full repository validation was attempted. Its database-backed tests could
  not run because no isolated `CONTROL_PLANE_TEST_DATABASE_URL` or PostgreSQL
  service was available on `localhost:5432`; the new tests passed in that run.

## Completion

All read/search audit calls were removed from admin GET handlers. Authentication
lifecycle events and mutation request, success, and failure records remain.
Existing read records are unchanged.
