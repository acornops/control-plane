# MCP PAT UI and backend parity

## Status

Completed on 2026-07-16.

## Goal

Close the MCP PAT recovery audit findings without changing credential ownership,
the gateway contract, or persistence. Public run conflicts must preserve a
bounded, structured description of the exact failed installation and tool.

## Boundaries

- Keep PATs component-local and out of responses, URLs, logs, fixtures, and
  durable browser state.
- Preserve `details.readinessErrors` for compatibility.
- Add only bounded `details.readinessFailures` fields: `serverId`, `toolName`,
  `code`, and optional `action`.
- Preserve distinct readiness codes for non-user principals, remote MCP policy,
  and unavailable installations.
- Keep the LLM gateway API and database schema unchanged.

## Implementation

- Normalize gateway readiness into a typed report and use it for target chat,
  direct Agent runs, and workflow messages.
- Document the additive conflict schema in OpenAPI and the contract manifest.
- Add focused tests for code mapping and secret-free response payloads.
- Coordinate the consumer update with `management-console`, then regenerate the
  public OpenAPI document in `docs-website`.

## Validation

- Focused readiness and controller tests.
- `npm run validate`.
- Workspace platform contract checks and the existing MCP integration stack.

## Outcomes

- Public target-message, direct-Agent-run, and workflow-message conflicts now
  preserve bounded structured readiness failures while retaining legacy strings.
- Direct Agent runs compile their reviewed capability mappings before checking
  exact MCP readiness.
- The public OpenAPI schemas and control-plane contract manifest document the
  additive recovery contract without exposing gateway connection snapshots.

## Evidence

- `npm run validate` passed in an isolated Node 22 container with the local
  PostgreSQL test database: 628 tests passed, followed by migrations, authz,
  membership, run-event, contract, OpenAPI, harness, and build checks.
- Focused readiness controller and service suites passed: 11 tests.
- The existing llm-gateway MCP PAT integration test passed against the local
  platform stack.
- Workspace `task runtime-truth:check` and `task validate` passed.
