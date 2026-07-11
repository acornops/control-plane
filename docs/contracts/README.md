# Control Plane Contracts

The control plane owns the platform API boundary. Keep this README as a short integration brief; do not turn it into a duplicated endpoint reference.

## Source Of Truth

- Complete endpoint and schema detail lives in the generated public docs at `https://docs.acornops.dev` and the local OpenAPI source under `src/docs/openapi`.
- Machine-checked counterpart coverage lives in `docs/contracts/manifest.json`.
- `scripts/check-contracts.mjs` verifies that implemented routes, OpenAPI paths, counterpart manifests, and the invariants below stay aligned.
- This README keeps only the contracts that are easy to lose in generated reference docs: ownership, auth boundaries, pagination shape, permission semantics, and cross-service behavior.

## Dependency Matrix

| Counterpart | Contract Surface | Enforcement |
| --- | --- | --- |
| Management console | Browser-facing auth, workspace, target, tooling, chat, run, workflow, and webhook APIs | OpenAPI, `manifest.json`, frontend service coverage checks |
| External integrations | Link creation, browser-link preview/completion, link resolution | OpenAPI and manifest checks |
| Execution engine | Internal run bootstrap, continuation, event ingest, commit, approvals, dispatch auth | Internal route, OpenAPI, and client checks |
| LLM gateway | Internal MCP registry admin client and built-in MCP bridge | Config, bridge controller, and manifest checks |
| AgentK | WebSocket lifecycle, snapshots, and built-in tool names | Agent route and tool-name checks |

## Shared Invariants

- Browser clients use cookie-backed auth and CSRF protection where required.
- List responses that paginate use `{ items, nextCursor? }`.
- Workspace audit filters expose `objectType`, `object`, and `operation`; `operation` is `read` or `write`.
- Audit events keep structured object details instead of forcing agents to reconstruct them from free text.
- Roles with `permissions.manage_mcp` may mutate MCP server configuration.
- Roles with `permissions.manage_tools` may mutate MCP per-tool enablement and non-Target-Insights built-in tool settings.
- Roles with `permissions.manage_target_insights` may mutate Target Insights entries and Target Insights tool settings.
- Roles without the relevant management capability are read-only for that configuration surface.
- Chat and run creation must preserve `sessionPolicy.allowedTools` and `sessionPolicy.writeEnabled`.
- Agent snapshots preserve `config.snapshotInterval`, `config.maxSnapshotBytes`, and `config.namespaceScope.{include,exclude}`.
- Agent namespace updates use `config/update_namespace_scope`.
- Kubernetes agent handshakes use exactly `agentType: agentk`; the legacy `k8s_agent` value is not supported.

## Boundary Notes

- Password signup creates the user account only; it does not create or attach a workspace.
- Workspace membership, audit-log access, target mutation, MCP mutation, tool mutation, Target Insights mutation, and AI settings mutation are permission-gated at the control-plane boundary.
- Execution-engine dispatch uses `Authorization: Bearer <EXECUTION_ENGINE_DISPATCH_TOKEN>`.
- The built-in MCP bridge registers as `acornops-cluster-agent` at `http://control-plane:8081/internal/v1/mcp`.
- Built-in MCP tool calls use `Authorization: Bearer <run-scoped-jwt>` and derive scope from `run-scoped-jwt-claims`.
- The built-in MCP bridge must classify calls as read or write before writing audit events.

## Change Checklist

When changing a route, schema, event, or cross-service field:

1. Update the implementation and OpenAPI source together.
2. Update `docs/contracts/manifest.json` for every counterpart that consumes the surface.
3. Keep this README focused on durable invariants only; do not paste endpoint lists here.
4. Run `npm run contracts:check`.
