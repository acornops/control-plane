# Target-independent Agent and Workflow runtime

Status: completed

## Goal

Make the Targets MCP facade the only interaction boundary between workspace
Agents or Workflows and targets. Target inventory and connector lifecycle must
not create, remove, or refresh Agent capability mappings or Workflow readiness.
Target identity is selected and validated only in Targets MCP tool arguments.

Because the application has not been released, finish the work against one
greenfield SQL baseline and remove superseded migration scaffolding.

## Completed work

- [x] Replaced target-inventory-derived Agent capability mappings with stable
  platform Targets MCP capability mappings.
- [x] Resolved Targets MCP tool metadata independently of workspace target
  inventory and kept target selection in call-time arguments.
- [x] Removed target lifecycle hooks into Agent and Workflow readiness.
- [x] Hardened execution and gateway scope contracts so Agent-chat and Workflow
  variants reject target identity by construction and validation.
- [x] Collapsed control-plane SQL into `001_initial_schema.sql` and removed
  superseded migration files and checks.
- [x] Removed retired Agent and Workflow definition version, origin, and
  template-compatibility metadata across SQL, services, contracts, and clients.
- [x] Consolidated Target-chat and Agent-chat lifecycle behavior in the neutral
  conversation runtime without routing Agent chat through Workflow execution.
- [x] Added focused empty-workspace, lifecycle-independence, scope-boundary,
  schema, contract, connector-handshake, and conversation regressions.
- [x] Audited test additions and removed obsolete parser, compatibility, and
  duplicate fixture coverage.

## Validation

- Control plane: 1,100 tests plus auth, durability, contract, OpenAPI, harness,
  TypeScript build, and fresh PostgreSQL baseline introspection passed.
- Execution engine: 233 unit/component tests, 29 keyless evaluations, and five
  clean-container integration scenarios passed.
- Gateway, AgentK, AgentV, management console, documentation, deployment, and
  workspace cross-repository guards passed their applicable validation suites.
- AgentK live connector E2E passed; AgentK and AgentV connector version
  handshakes remain distinct from removed Agent/Workflow definition versioning.

## Invariants

- Agent and Workflow definitions never store target identity or target scope.
- Target creation, deletion, connection, and tool discovery never mutate Agent
  or Workflow definitions, mappings, or readiness.
- The Targets MCP server and its stable tool catalog can be granted like any
  other MCP server without selecting a target.
- `target_id` and `target_type` are required only inside a Targets MCP tool
  invocation and are stripped before forwarding connector-native arguments.
- Workflows relate to Agents only through assignment and immutable run
  snapshots of those assigned Agents' current capabilities.
- Agent and Workflow definitions have no version model.
