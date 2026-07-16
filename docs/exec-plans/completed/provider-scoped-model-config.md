# Provider-scoped model configuration

## Goal

Remove the legacy flat `LLM_ALLOWED_MODELS` configuration path and make
`LLM_ALLOWED_PROVIDER_MODELS` the sole model-policy input.

## Constraints

- Preserve the derived flat `allowedModels` runtime/API representation where it
  remains an active compatibility contract.
- Coordinate deployment configuration so operators have a first-class setting
  before the legacy fallback is removed.
- Keep `LLM_ALLOWED_PROVIDERS` as an independently enforced policy ceiling.

## Decision log

- `LLM_ALLOWED_PROVIDER_MODELS` is the canonical configuration because model
  identity is provider-scoped.
- The deployment change may roll out before the control-plane cleanup because
  current control-plane releases already support the provider-scoped variable.

## Validation log

- `node --test --import tsx test/config-llm-policy.test.ts test/workspace-ai-settings-controller.test.ts` passed (18 tests).
- `npm run typecheck` passed.
- `npm run contracts:check` passed.
- `npm run validate` reached the full test suite but the repository's
  database-backed tests require test environment configuration not supplied by
  the script. A retry with `NODE_ENV=test` then required
  `CONTROL_PLANE_TEST_DATABASE_URL`. Targeted tests and all non-database checks
  relevant to this change passed.
- Workspace `node scripts/harness/check-platform-contracts.mjs` passed.

## Completion criteria

- No control-plane configuration, examples, or tests reference
  `LLM_ALLOWED_MODELS`.
- Provider-scoped policy parsing and startup validation remain covered.
- Targeted policy, type, contract, and cross-repository checks pass.
