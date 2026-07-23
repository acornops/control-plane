# Structured LLM provider configuration

## Goal

Replace the duplicated provider and provider-model environment policy with one
JSON provider map whose keys define the allowed providers and whose arrays
define their allowed models.

## Constraints

- This is an explicitly accepted breaking configuration change.
- Preserve the existing derived AI settings API fields.
- Reject malformed, empty, unsupported, or internally inconsistent policy at
  startup.
- Coordinate the new environment contract with deployment and demo-infra.

## Decision log

- `LLM_PROVIDERS_JSON` is the sole control-plane provider-policy input.
- `LLM_DEFAULT_PROVIDER` and `LLM_DEFAULT_MODEL` remain explicit because map
  order must not select runtime defaults.
- Runtime `allowedProviders`, `allowedProviderModels`, and `allowedModels`
  remain derived values.

## Validation log

- `npm run typecheck` passed.
- `npm run style:check` passed.
- `node --test --import tsx test/config-llm-policy.test.ts test/workspace-ai-settings-controller.test.ts`
  passed (22 tests).
- Migration, authorization, membership, run-event, contract, OpenAPI, harness,
  and build checks passed.
- Full `npm run validate` reached the repository test suite: 728 tests passed
  and 111 database-backed tests failed because
  `CONTROL_PLANE_TEST_DATABASE_URL` was not configured.
- Workspace platform contract checks passed.

## Completion criteria

- The old provider-policy environment variables are removed.
- Startup validation covers the new JSON contract and default membership.
- Targeted, repository, contract, and cross-repository checks pass.
