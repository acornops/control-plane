# Platform Admin Console Producer Integration

Status: complete
Branch: `feat/platform-admin-console`
Consumer: `platform-admin-console`

## Outcome

Provide the smallest production producer surface required by the governance-only console:

- dedicated human platform-admin OIDC sessions with MFA assurance, three fixed roles, CSRF protection, recent-auth write checks, and a separate internal BFF credential;
- audited workspace suspension and restoration that retain memberships and workload state while blocking ordinary workspace discovery and authorization;
- authoritative paginated workspace-member reads with stable cursors;
- transaction-backed membership mutation plus protected Admin Audit and sanitized workspace audit records;
- immutable human actor fields, fixed audit action groups, and correlation IDs for governance tracing.

The consumer remains plan-only, excludes quota overrides and operational admin routes, and cannot create users or orchestrate bulk offboarding.

## Safety And Compatibility

- Routes remain backward compatible and require existing least-privilege admin scopes.
- Lifecycle transitions require exact workspace-name confirmation and conditional state changes.
- Membership audit persistence failure rolls back the membership mutation.
- Workspace-visible audit actors use a generic platform-administrator label; protected administrator identity remains in Admin Audit.
- The existing quota-override endpoint remains available to other consumers but is absent from the platform-admin manifest and allowlist.

## Validation

- Full `npm run validate` passed against isolated PostgreSQL and Redis after merging the current Workflow V2 `main`: tests, typecheck, style, the single greenfield schema, authorization, membership, run-event durability, contracts, OpenAPI, harness, and build.
- Platform-admin `npm run validate` passed: 86/86 tests plus the 15-route/7-scope consumer contract, requirements, harness, build, and smoke checks.
- The platform-admin production Docker image built successfully from the pinned Node 22 Alpine base digest with zero dependency vulnerabilities reported during installation.
- A packaged-container smoke confirmed the non-root image binds on `0.0.0.0:4173`, serves health and shell routes, and denies a non-allowlisted API route.
- Parent and deployment contract validation passed.

## Rollout

1. Provision new databases from `001_initial_schema.sql`, which includes the platform-admin lifecycle and protected human-audit fields. Do not restore obsolete incremental migrations `002`-`012`.
2. Deploy the control-plane producer before the console consumer.
3. Keep the console disabled until staging verifies OIDC claims, secrets, ingress TLS, internal mTLS, NetworkPolicy, readiness, and rollback.
