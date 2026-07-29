# User Sign-In Methods

Status: complete
Branch: `feat/user-sign-in-methods`

## Outcome

Replaced the platform setting's self-service-signup-only behavior with an
effective user sign-in method policy. Platform administrators can choose one
or both deployment-configured methods: `password` and `oidc`.

## Compatibility And Safety

- Publishes `user_sign_in_methods` as the new runtime/API key while retaining
  legacy `password_signup` rows in storage through a forward migration.
- Interprets legacy `{ enabled: boolean }` overrides without losing access;
  newly written values use `{ methods: ["password", "oidc"] }`.
- Requires a non-empty requested method list, constrains it to configured
  deployment methods, and never lets a runtime setting enable OIDC itself.
- Gates password login, signup, reset, and change server-side. Gates ordinary
  OIDC login and callback server-side, while allowing authenticated account
  linking and external-integration link transactions to finish.
- Leaves platform-admin OIDC unchanged.

## Validation

- Focused tests pass: platform-setting policy/resolution, runtime auth config,
  password verification/reset/change, and ordinary OIDC policy rechecks.
- `npm run typecheck`, `npm run style:check`, `npm run contracts:check`,
  `npm run openapi:check`, and `npm run migrations:check` pass.
- Migration SQL introspection was not run because
  `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` was not provided.
