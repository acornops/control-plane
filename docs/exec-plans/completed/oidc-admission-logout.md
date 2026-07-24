# OIDC admission and RP-initiated logout

## Goal

Add fail-closed OIDC admission rules, explicit OIDC enablement, versioned browser-session provenance, and RP-initiated provider logout with a local-only fallback.

## Decisions

- An omitted admission policy allows any successfully authenticated OIDC identity.
- Admission evaluates verified ID-token and subject-bound UserInfo claims before persistence.
- Conflicting claim values deny admission.
- OIDC callback state is cryptographically bound to the initiating browser.
- A previously unseen OIDC subject is never attached to an existing account by email alone.
- Logout revokes the current AcornOps session before redirecting to the provider.
- Existing unversioned Redis sessions are invalidated; no compatibility alias is retained for `OIDC_REQUIRE_VERIFIED_EMAIL`.

## Validation

- Focused admission, exchange, session, controller, logout, configuration, integration-link, and OpenAPI suites pass.
- Typecheck, style, harness, contracts, OpenAPI checks/export, and production build pass.
- The repository-wide database test suite still requires `CONTROL_PLANE_TEST_DATABASE_URL`; it was not rerun without that integration dependency.
- Workspace platform-contract and platform-harness validation pass.
- Final review made session creation, rotation, refresh, and logout atomic; hardened discovery, ID-token, state, URL, and account-link validation; and verified admission ordering for every callback purpose.

## Completion criteria

- Keycloak logout ends the provider session and returns through a state-validated callback.
- Unsupported providers complete local logout and surface a bounded warning.
- Admission denial creates no user, link, integration link, or session.
- Tokens, claims, emails, handoff handles, and logout state are absent from logs and browser payloads.
