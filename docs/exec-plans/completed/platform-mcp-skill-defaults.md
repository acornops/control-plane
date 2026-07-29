# Platform Capabilities Defaults

## Goal

Persist a small platform-wide initialization list of MCP server and skill
definitions and copy it once when a new workspace is created.

## Constraints

- Support only `mcp_server` and `skill`.
- Support one or more unique availability destinations: `agents`,
  `kubernetes`, and `virtual_machines`. `All` is a UI shorthand for selecting
  all three destinations.
- Never receive or store MCP credentials in the admin API.
- Validate HTTPS MCP endpoints and pinned, valid skill bundles.
- Copy the current definitions into a detached workspace snapshot only when the
  workspace row is first created.
- Never backfill or update an existing workspace snapshot after Platform Admin
  additions, availability edits, or removals.
- Do not change built-in tool, AgentK, AgentV, or native function contracts.
- Materialize a snapshot row as a normal local installation only when a
  workspace user explicitly enables it with existing permissions.
- Deduplicate by canonical source identity.
- Do not store revisions, promotion bindings, or compatibility columns.

## Decision Log

- Use a detached per-workspace initialization snapshot so future Agents and
  targets see the defaults selected when their workspace was created.
- Expose only the inherited/local distinction needed by MCP and skill
  inventory DTOs.
- Store canonical destination arrays directly in the unreleased schema.
- Reuse the existing `admin:system:read` and `admin:system:write` scopes because
  defaults are system settings.

## Validation

- Passed typecheck, style, harness, migration, authorization, membership,
  run-event, contract, OpenAPI, and build checks.
- Focused tests cover admin roles, initialization snapshots, Agent and target
  resolution, deduplication, endpoint safety, and native-tool regressions.
- PostgreSQL-backed integration and SQL migration introspection passed against
  a disposable local database.

## Completion Criteria

The fixed admin API is usable by the Platform Admin console, new workspaces
receive a detached disabled snapshot, existing workspaces remain unchanged by
later platform edits, and native tools are unchanged.
