# Target-independent Agent and Workflow runtime

Status: active

## Goal

Make the Targets MCP facade the only interaction boundary between workspace
Agents or Workflows and targets. Target inventory and connector lifecycle must
not create, remove, or refresh Agent capability mappings or Workflow readiness.
Target identity is selected and validated only in Targets MCP tool arguments.

Because the application has not been released, finish the work against one
greenfield SQL baseline and remove superseded migration scaffolding.

## Plan

- [ ] Replace target-inventory-derived Agent capability mappings with stable
  platform Targets MCP capability mappings.
- [ ] Resolve Targets MCP tool metadata independently of workspace target
  inventory and keep target selection in call-time arguments.
- [ ] Remove target lifecycle hooks into Agent and Workflow readiness.
- [ ] Harden execution and gateway scope contracts so Agent-chat and Workflow
  variants reject target identity by construction and validation.
- [ ] Collapse control-plane SQL into `001_initial_schema.sql` and remove
  superseded migration files and checks.
- [ ] Add empty-workspace, lifecycle-independence, scope-boundary, schema, and
  contract regressions.
- [ ] Run repository and workspace production validation and move this plan to
  `completed/` only after all required checks pass.

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
