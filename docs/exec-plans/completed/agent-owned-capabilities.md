# Agent-owned capabilities

## Goal

Restore Agents as the only owners of tools, skills, and MCP servers. Workflows
derive their complete effective capability set from the Agents they assign.

## Decisions

- Remove Workflow capability selection, restriction, implicit data-access, and
  approval-policy fields. Execution governance comes from the selected Agent
  snapshots and workspace authorization.
- Remove the prompt-resource reading native tool.
- Keep Fetch as an Agent-owned configurable native tool. Direct Agent chat and
  Workflow specialist runs may use it when the selected Agent has it enabled.
- Give every Agent one platform-managed AcornOps Targets MCP server with
  `list_targets`, `get_target`, and `list_target_issues`.
- Register and snapshot that server through the ordinary Agent MCP path. The
  platform owns its connection; users may toggle the server and its tools.
- Remove the synthetic workspace-level Targets MCP catalog and infrastructure
  capability mappings.
- Change the greenfield schema and current contracts in place. Do not add data
  migrations, compatibility readers, or legacy request handling.

## Work

- [x] Simplify Workflow persistence and compilation to Agent-derived access.
- [x] Restore the built-in Agent Targets MCP catalog, executor, and sync.
- [x] Make Fetch visible and configurable on Agents and remove prompt resources.
- [x] Remove synthetic Targets MCP routing.
- [x] Align management-console contracts and capability views.
- [x] Update mirrored contracts, fixtures, tests, and documentation.
- [x] Run targeted and repository validation.
