# Remove Context Grants

## Goal

Remove the unused context-grant model from Agents, Workflows, schedules,
webhooks, run tokens, and the management console. Runtime context remains
authorized through explicit prompt-resource bindings and tool permissions.

## Plan

- Remove context-grant fields from the control-plane schema, DTOs, OpenAPI,
  access compilers, triggers, and signed run claims.
- Remove raw context-grant inputs and summaries from the management console.
- Remove the unused claim parser from llm-gateway and synchronize contract
  manifests and public documentation.
- Update tests and fixtures, then run repo-local and platform contract checks.

## Compatibility

This is an intentional breaking removal across the pinned pre-release service
matrix. The current greenfield database epoch requires recreation rather than
in-place upgrades, so the baseline schema can drop the unused columns directly.

## Validation

- Targeted control-plane, management-console, and llm-gateway tests.
- Repository contract and validation entrypoints.
- `node scripts/harness/check-platform-contracts.mjs` from the workspace root.

## Outcome

Removed context grants from the greenfield control-plane schema, Agent and
Workflow contracts, schedule and webhook persistence, run-scope JWTs,
llm-gateway claims, management-console forms and models, generated OpenAPI, and
public documentation. Explicit resource bindings and tool permissions remain
the runtime authorization boundary.

Validation completed:

- Control plane: typecheck, style, authorization, membership, run-event,
  migration, contract, OpenAPI, harness, clean-output build, focused access and
  token tests, and repository diff checks passed.
- Management console: app typecheck, 42 focused tests, contract checks, and the
  production control-plane-mode build passed.
- LLM gateway: contract checks and source diff checks passed; the canonical
  task is blocked because the workspace has Python 3.12.3 instead of 3.12.11
  and no installed test environment.
- Docs: repository content checks passed; Mintlify validation and link checking
  are blocked because the workspace has Node 18 instead of Node 20.17+.
- Workspace source and contract scan found no remaining context-grant fields.

The full control-plane suite passed 191 files and failed 40 database-backed
files because no isolated test database is configured and sandboxed localhost
connections are denied. The platform contract harness is independently blocked
by the missing `control-plane/test/fixtures/workflow-template-conformance.json`
fixture. Management-console full validation is independently blocked by
pre-existing design-adoption and file-budget findings in unrelated dirty files.
