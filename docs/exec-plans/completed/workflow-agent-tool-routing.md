# Workflow Agent Tool Routing

## Goal

Remove workflow-level target binding. A workflow selects Agents and inherits their allowed tools; when a target MCP tool is called, the model supplies an eligible `target_id` from the tool schema.

## Constraints

- Preserve exact server/tool/target authorization at the gateway.
- Keep target-scoped chat runs separate from Workflow execution and keep coordinated delegation target-free.
- Do not expose target selection, candidates, or setup state as workflow concepts.
- Keep Kubernetes and virtual-machine routing target-neutral at shared boundaries.

## Target boundary

| Concept | Shared target model | Kubernetes-specific | VM-specific | Notes |
| --- | --- | --- | --- | --- |
| Workflow assignment | Agent IDs only | No | No | Workflows do not own targets. |
| Tool selection | Signed target route | AgentK server/tool | AgentV server/tool | `target_id` is a tool argument. |
| Authorization | Workspace, Agent, alias, server/tool, target | No | No | Gateway fails closed on an unlisted route. |
| Availability | Target registry/tool catalog | AgentK health | AgentV health | Failure occurs only when a selected tool route is unavailable. |

## Decision log

- Removed `resource_requirements` from the workflow API, types, repository, and immutable baseline schema. Existing pre-release databases follow the repository's schema-reset policy.
- Compiled every reviewed target-tool mapping inside the assigned specialist Agent's scope.
- Added `target_id` to the model-facing schema only for target MCP tools and routed it in the execution engine.
- Signed every allowed target route into the run token and verified the exact route in llm-gateway.
- Restricted coordinator delegation to capability, task prompt, and required/optional status; the control plane selects an eligible specialist without a target binding.
- Bound write approvals to the chosen route while keeping `target_id` out of the downstream MCP arguments.

## Validation log

- Control plane: typecheck, style, migrations, contracts, and public/admin OpenAPI checks passed; focused workflow, token, template, and access tests passed (25 tests in the main focused batch, plus 7 access tests after optional-delegation cleanup).
- Execution engine: lint and contracts passed; unit suite passed (219 tests).
- LLM gateway: Python compatibility, lint, and contracts passed; unit suite passed (541 tests).
- Management console: lint, contracts, and harness passed; unit suite passed (778 tests across 164 files).
- Documentation: navigation/content checks passed for 42 pages.
- Workspace: cross-repository contracts and platform harness checks passed.
- Database-backed control-plane delegation tests were not executed because `CONTROL_PLANE_TEST_DATABASE_URL` was not available; their invocation failed at the fixture precondition before running test logic.

## Completion criteria

- Fresh and existing built-in workflows launch without selecting a target.
- Target MCP calls work only for a signed target route chosen by `target_id`.
- Workflow APIs and console contain no target-binding status or fields.
- Coordinated workflows delegate capability-scoped tasks without target fields.
- Cross-repository contract checks and relevant tests pass.
