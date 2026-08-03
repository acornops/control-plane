# Configurable Help Links

## Goal

Add a versioned `help_links` platform setting with built-in AcornOps defaults,
and expose its effective documentation and support destinations to the
Management Console without requiring deployment configuration.

## Compatibility boundary

- Preserve the current documentation and support URLs when no override exists.
- Keep the setting optional for consumers during rolling upgrades.
- Accept only bounded HTTPS documentation URLs and HTTPS or `mailto:` support
  URLs without credentials.
- Reuse the existing audited platform-setting storage and invalidation path.
- Add fields to the existing auth configuration response without changing any
  existing field or authentication behavior.

## Validation plan

- Add focused parsing, state, controller, and OpenAPI contract coverage.
- Run typecheck, contract checks, harness checks, and repository validation.
- Run the workspace platform-contract check with both consumer manifests.

## Outcome

- Implemented the additive `help_links` setting, its forward constraint
  migration, and the optional `helpLinks` auth configuration projection without
  rewriting existing setting data.
- The baseline-to-forward migration chain passes against isolated PostgreSQL
  and persists a representative `help_links` override under the expanded key
  constraint.
- Full repository validation passes against isolated PostgreSQL and Redis:
  1,106/1,106 tests, typecheck, style, migration, authorization, membership,
  run-event, contract, OpenAPI, harness, and production build checks.
- The workspace platform-contract check also passes with both consumers.
