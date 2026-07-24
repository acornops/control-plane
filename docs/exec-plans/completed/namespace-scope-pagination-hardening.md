# Namespace Scope and Pagination Hardening

## Goal

Apply namespace-scope changes before a settings update completes and filter normalized Kubernetes inventory by the saved scope immediately.

## Completed

- Connected agents must acknowledge a namespace-scope update before the settings response completes.
- Failed live updates close the stale connection so reconnect handshake applies the persisted scope.
- Normalized resource queries apply saved include/exclude lists immediately while retaining cluster-scoped resources.
- Focused controller and repository tests cover acknowledgement, failure disconnect, and scoped inventory SQL.

## Validation

- Focused scope and normalized inventory tests pass.
- Typecheck, style, contracts, harness, and build pass.
- Full validation reaches the repository test step but requires the unavailable `CONTROL_PLANE_TEST_DATABASE_URL` for database-backed suites.
