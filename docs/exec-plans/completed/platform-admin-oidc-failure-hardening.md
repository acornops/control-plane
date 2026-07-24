# Platform Admin OIDC Failure Hardening

Status: complete
Branch: `feat/platform-admin-console`
Consumer: `platform-admin-console`

## Outcome

Keep the dedicated platform-admin OIDC boundary fail closed without exposing a
generic internal-server response to an administrator. Production configuration
must retain the one-hour absolute session limit and 15-minute idle/recent-auth
limits. Identity-provider discovery and transport failures must produce a
stable, retryable public response while preserving the detailed reason in
metrics, structured logs, and protected Admin Audit.

## Scope

- Classify OIDC dependency, configuration, authorization, and assurance errors.
- Return stable public auth failures with request correlation.
- Reject production platform-admin session limits that exceed the security
  baseline.
- Preserve the existing routes, roles, MFA requirement, PKCE, CSRF, and BFF
  credential boundary.

## Validation

- Focused admin OIDC/config tests passed.
- Full control-plane suite passed: 633/633 tests, typecheck, style, isolated SQL
  migration validation, authorization, membership, run-event durability,
  contracts, public/admin OpenAPI, harness, and build.
- Consumer and deployment contract alignment passed.
