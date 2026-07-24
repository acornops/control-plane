# Remove Public Standalone Agent Runs

## Goal

Remove every public or unattended path that can create a standalone
Agent run while preserving the internal specialist-child execution path used by
coordinated Workflows.

## Boundaries And Decisions

- Remove the manual Agent-run API, Agent activity API, Agent trigger APIs, and
  signed Agent webhook API.
- Stop schedule and target-event production for Agent triggers.
- Remove trigger and standalone-run fields from the public Agent/OpenAPI
  contract.
- This plan was superseded by the unified Workflow execution graph, which
  removed the remaining internal Agent-run persistence and bootstrap paths.

## Validation

- `npm run typecheck` passed.
- `npm run contracts:check` passed.
- `npm run validate` passed with 839 tests, contract/OpenAPI checks, harness
  checks, and the production build.
- `NODE_ENV=test node --import tsx --test
  test/repository-development-seed.test.ts` passed after removing its obsolete
  Agent-trigger query stubs.
- Static scans confirmed that public standalone execution paths were removed.

## Documentation Impact

- Updated the security model and contract manifest to state that Agents execute
  only through Workflows.
- Regenerated the public OpenAPI document consumed by the docs website.

## Completion Criteria

No public route or background worker can create a standalone Agent run, the
delegated specialist path remains compiled, and the public contract no longer
advertises standalone Agent runs or Agent triggers.
