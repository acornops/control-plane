# Platform default LLM credentials

Status: complete

## Goal

Expose fixed, audited `/admin/v1` operations for platform-default provider
credentials and carry effective credential source metadata to workspace AI
settings.

## Boundaries

- `control-plane` never stores or returns provider key values.
- Only `admin:system:read` may read provider status and only
  `admin:system:write` may replace or delete a platform default.
- Gateway calls use the existing internal service credential.
- Audit metadata contains provider and action only, never key material.
- Existing workspace credential routes remain backward compatible.

## Validation

- Focused admin-controller, gateway-client, and workspace AI settings tests.
- OpenAPI and contract checks.
- `npm run typecheck`, `npm run contracts:check`, `npm run harness:check`, and
  `npm run validate`.

## Outcome

- Fixed system routes expose status, replacement, and deletion with audited
  `admin:system` scopes.
- Workspace AI settings propagate the effective credential source without key
  material.
- Typecheck, focused 17-test coverage, contracts, and OpenAPI checks passed.
- The full suite was attempted outside the sandbox but the local Postgres
  service was unavailable.
