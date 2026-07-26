# Agents and Workflows UX Hardening

## Goal

Make agent and workflow state durable, remove fabricated workflow options, add
shareable pagination and schedule-preview contracts, and preserve RBAC, audit,
versioning, approval, and scheduler safety behavior.

## Constraints

- Keep existing create, update, and delete payloads backward compatible.
- Create canonical default workflows once per workspace as ordinary editable,
  workspace-owned definitions. AcornOps-provided Agents remain managed
  definitions, but the platform never overwrites or restores default workflows.
- Keep variable definitions and compiled scopes in validated JSONB while storing
  queryable identity, status, ownership, and timestamps in columns.
- Never log prompts, input defaults, credentials, or context contents.
- Land the additive control-plane contract before its console consumer.

## Validation Plan

- Targeted repository, controller, migration, scheduler, and contract tests.
- `npm run validate`
- Workspace platform-contract check.
- Postgres/Redis integration profile when the local runtime is available.

## Production Validation Evidence

- `npm run validate` passed against the isolated local PostgreSQL test database:
  964 tests, type checking, style, migration static checks, authorization,
  membership, run-event durability, contracts, public and admin OpenAPI
  coverage, harness checks, and the production build.
- Greenfield migration SQL introspection also passed in a temporary schema on
  the isolated PostgreSQL database.
- The focused workflow-foundations PostgreSQL suite passed all five tests,
  including one-time default creation, no automatic overwrite or restoration,
  explicit re-add after deletion, stale-ID removal, and Agent replacement.
- Public OpenAPI coverage passed with 158 paths and 174 schemas; admin OpenAPI
  coverage passed with 28 paths and 27 schemas.

## Completion Criteria

- Migration and runtime paths persist agent/workflow state across processes.
- Catalog responses contain authoritative options and source diagnostics.
- List responses expose cursor pagination without breaking existing clients.
- Schedule preview validates without mutating state.
- Contract manifests and OpenAPI remain synchronized.

## Workspace MCP Repair

- Workspace MCP definitions are delegated to llm-gateway with explicit workspace scope; the control plane no longer stores or synthetically tests them.
- New workspaces seed no external repository MCP server or provider-specific tools.
- Agent grants are authoritative. Empty workflow restrictions inherit the selected agent's enabled MCP servers, tools, skills, and context grants; non-empty restrictions only narrow them.
- Launch fails with `WORKFLOW_CAPABILITY_NOT_READY` or `WORKFLOW_AGENT_SCOPE_DENIED` when a selected capability is disconnected, disabled, deleted, or no longer granted.
- The workflow-options contract no longer contains a repository catalog.
