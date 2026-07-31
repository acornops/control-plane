# Admin Audit Event Filter Coverage

## Goal

Expose fixed Admin Audit action groups for every mutation available through the
Platform Admin Console, including request-stage records where they exist.

## Scope

- Add producer-owned groups for platform settings, default LLM keys, capability
  defaults, workspace plans, workspace status, and workspace access.
- Preserve the existing `action` and `actionGroup` query contract.
- Expand groups to include canonical mutation actions and their request-stage
  variants.
- Update OpenAPI, mirrored manifests, generated documentation, and focused
  contract tests.

## Validation

- Focused producer action-group tests.
- Producer type, contract, OpenAPI, harness, and build checks.
- Consumer validation and live browser verification.
- Cross-repository contract and docs checks.

## Outcome

- Added six fixed producer-owned mutation groups covering all 13 canonical
  write actions exposed by the Platform Admin Console.
- Each group includes the canonical action and its `.request` variant so a
  filtered view retains request-stage records.
- Preserved exact `action` filtering and the two existing `actionGroup` values.

## Validation Evidence

- `NODE_ENV=test node --import tsx --test --test-concurrency=1
  test/admin-audit-action-groups.test.ts
  test/admin-controller-security.test.ts`: 17 tests passed.
- `npm run typecheck`, `npm run style:check`, `npm run contracts:check`,
  `npm run openapi:check`, `npm run harness:check`, and `npm run build`: passed.
- The generated admin OpenAPI document validates through the documentation
  build and link checker.
- The workspace contract checker confirms the control-plane and Platform Admin
  Console mirrors match. Unrelated existing mismatches remain for the
  management-console, llm-gateway, and agentk mirrors.
