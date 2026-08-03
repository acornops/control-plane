# Agent Chat Capability Preview

## Goal

Expose a display-safe, authoritative preview of the tools and skills available
to a direct Agent chat run for the requesting user and access mode.

## Constraints

- Reuse the same scope compiler and authorization checks as Agent chat dispatch.
- Never expose credentials, endpoint URLs, headers, tool schemas, arguments, or
  the internal compiled scope.
- Keep the endpoint read-only; it creates no conversation, run, approval, or
  audit record.
- Preserve existing target-chat and Agent-chat behavior.

## Decision Log

- Add an Agent-scoped preview endpoint rather than deriving effective tools in
  the browser from Agent configuration.
- Return the same display vocabulary used by target-chat capability previews so
  the management console can reuse one control.
- Reuse Agent dispatch policy, run-scope compilation, and exact MCP readiness so
  preview and dispatch cannot silently disagree.
- Include the resolved runtime selection on accepted message and public run
  responses so the shared model selector is authoritative for Agent chat too.

## Validation Log

- `npm run typecheck`: passed.
- `npm run style:check`, `npm run migrations:check`, `npm run authz:check`,
  `npm run membership:check`, `npm run run-events:check`,
  `npm run contracts:check`, `npm run openapi:check`, `npm run harness:check`,
  and `npm run build`: passed. Migration validation was static because no
  migration database URL was configured.
- `NODE_ENV=test node --import tsx --test --test-concurrency=1 test/agent-chat.test.ts`:
  passed.
- `npm run validate`: static gates passed and 935 tests passed; 157 database
  integration tests, including the new endpoint integration case, could not run
  because `CONTROL_PLANE_TEST_DATABASE_URL` was not configured.
- Workspace platform-contract validation passed against the management-console
  mirror.

## Completion Criteria

- The route, OpenAPI schema, response map, and counterpart manifests agree.
- Controller tests cover authorization, access-mode filtering, and bounded
  display-safe output.
- Control-plane and platform contract validation passes.

Completed on 2026-08-03. The database-backed controller case remains for CI or
a workspace with an isolated control-plane test database.
