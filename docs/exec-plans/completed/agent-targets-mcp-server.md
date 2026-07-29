# Agent Targets MCP server

## Status

Completed after a final production-readiness review on 2026-07-30.

## Goal

Give every Agent one platform-managed Targets MCP server with exactly three
read-only tools: `list_targets`, `get_target`, and `list_target_issues`.

## Boundaries

- Reuse the existing built-in target MCP registration and bridge patterns.
- Keep Agent target scope authoritative at catalog registration and execution.
- Keep the server toggleable while preventing connection, deletion, and
  individual tool mutations.
- Preserve exact model alias and registry server/tool authorization.
- Avoid execution-engine changes unless its generic MCP contract is
  insufficient.

## Review checklist

- Verify Agent creation, update, deletion, and periodic reconciliation behavior.
- Verify gateway registry uniqueness, provenance, and schema compatibility.
- Verify run-token, pinned snapshot, alias, and exact tool-reference checks.
- Verify pagination and scope filtering occur before results are returned.
- Verify error, audit, timeout, and duplicate-registration behavior.
- Add regression tests for uncovered server management and execution paths.

## Validation

- Focused control-plane feature suite passed, including serial PostgreSQL
  management, bridge, no-op reconciliation, and snapshot-drift repair coverage.
- Exact control-plane `npm run validate`: 1,063/1,063 tests and every check
  through OpenAPI passed; the chain then stopped at the pre-existing,
  feature-unrelated `src/config.ts` line budget (553 versus 550). The build
  passed independently.
- LLM gateway `task validate`: 491/491 passed, including a real
  Agent-scoped built-in server registration handler test.
- Execution engine `task validate`: 203/203 passed with one existing Starlette
  deprecation warning.
- Workspace platform-contract and runtime-truth checks passed.
- A live source-mounted integration stack completed a signed specialist
  `list_targets` call through LLM gateway to control-plane and returned both
  scoped seeded targets. The temporary run and session were removed afterward.
- `docker compose --profile integration up -d --build` was attempted and
  a final image-only build retry was also attempted. Both stopped while Docker
  remained blocked resolving uncached public Node and Python base-image
  metadata; no application compilation or container-start failure surfaced,
  and Compose reported no partial containers afterward.

## Outcome

- Every Agent is reconciled with one toggleable, platform-managed
  `acornops-targets` MCP server containing exactly the three requested
  read-only tools.
- Agent target scope is applied in SQL list filtering and rechecked for point
  reads and issue reads from the pinned run snapshot.
- Unbound Agents can discover scoped targets, while ordinary constrained MCP
  installations still require a matching bound target.
- Built-in connection changes, deletion, and individual tool mutations are
  denied; whole-server enable/disable remains available.
- Gateway bridge calls carry and independently authorize the model alias and
  exact server/tool reference.
- Initial Agent creation preserves version 1, while later platform
  reconciliation increments the Agent version and rebinds only mappings that
  were valid for the immediately preceding version. Stale mappings remain
  stale.
- Existing Kubernetes and VM built-in tools continue to route by exact server
  identity even if a canonical tool name collides with the Agent Targets
  catalog.
- Equivalent Agent target constraints are canonicalized before registry
  synchronization, preventing recurring gateway revisions and Agent version
  churn when array ordering differs.
- Periodic reconciliation now repairs complete installation snapshot drift
  while remaining version-stable and quiet when registry and snapshot state
  already match.
- Explicitly selected target scopes with no selected types or IDs fail closed
  at validation, authorization, and query execution boundaries.
- Reconciliation also repairs authentication, credential-mode, and public
  header drift on the platform-managed connection.
- The required rolling deployment order is documented as LLM gateway first,
  then control-plane, so bridge calls always carry the exact alias and
  server/tool reference expected by the control-plane.
- No execution-engine code change was required because its generic MCP
  capability contract already carries the necessary fields.
