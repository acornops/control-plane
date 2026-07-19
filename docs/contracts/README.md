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
| External integrations | Link creation, browser-link preview/completion, link resolution, and linked bot read access | OpenAPI, manifest checks, and endpoint contract docs |
| Execution engine | Internal run bootstrap, continuation, event ingest, commit, approvals, dispatch auth | Internal route, OpenAPI, and client checks |
| LLM gateway | Internal MCP registry admin client and built-in MCP bridge | Config, bridge controller, and manifest checks |
| AgentK | WebSocket lifecycle, snapshots, and built-in tool names | Agent route and tool-name checks |

## Shared Invariants

- Browser clients use cookie-backed auth and CSRF protection where required.
- List responses that paginate use `{ items, nextCursor? }`.
- The workspace approval inbox additionally requires `pendingCount`, the workspace-scoped total of pending target-tool and workflow-gate approvals before pagination and independently of the requested list filter.
- Workspace audit filters expose `objectType`, `object`, and `operation`; `operation` is `read` or `write`.
- Audit events keep structured object details instead of forcing agents to reconstruct them from free text.
- Roles with `permissions.manage_mcp` may mutate MCP server configuration.
- Roles with `permissions.manage_tools` may mutate MCP per-tool enablement and non-Target-Insights built-in tool settings.
- Workspace workflow MCP configuration is gateway-owned. The control plane authorizes `manage_mcp`, delegates with explicit workspace scope, returns secret-free DTOs, and audits mutations.
- Agents grant workflow MCP capabilities. Empty workflow restrictions inherit selected-agent grants; non-empty restrictions narrow them.
- Roles with `permissions.manage_target_insights` may mutate Target Insights entries and Target Insights tool settings.
- Roles without the relevant management capability are read-only for that configuration surface.
- Chat and run creation must preserve `sessionPolicy.allowedTools` and `sessionPolicy.writeEnabled`.
- Chat session responses derive `lastRuntimeSelection` from the newest accepted
  run snapshot regardless of its eventual terminal status; empty sessions omit
  it, and message acceptance echoes the runtime frozen on that run.
- Agent handshake responses always include a complete `sessionPolicy`; AgentK rejects tool calls until it is installed.
- The Kubernetes built-in catalog contains `list_resources`, `get_resource`,
  `get_resource_logs`, `restart_workload`, `scale_workload`, and `patch_resource`.
- Agent snapshots preserve `config.snapshotInterval`, `config.maxSnapshotBytes`, and `config.namespaceScope.{include,exclude}`.
- Agent namespace updates use `config/update_namespace_scope`. A connected
  AgentK must acknowledge the update before the cluster settings response
  completes; normalized Kubernetes resource reads also enforce the saved scope
  while a fresh snapshot is being collected.
- Built-in tool calls preserve the run-scoped model tool call ID as a stable,
  hashed agent JSON-RPC request ID for write idempotency.
- Kubernetes agent handshakes use exactly `agentType: agentk`; the legacy `k8s_agent` value is not supported.
- Kubernetes built-in calls must preserve the strict AgentK MCP envelope. Raw
  AgentV read-only results are wrapped as MCP content by the bridge and remain
  ineligible for full-result artifact retention.
- Calls that cannot be dispatched because the target agent is disconnected
  return HTTP 503 with retryable `TARGET_AGENT_UNAVAILABLE` and
  `outcome: not_started`; arbitrary upstream bodies remain hidden.
- AgentK catalog synchronization fails closed when any tool omits a valid
  output schema or artifact policy. AgentV and other non-AgentK built-ins are
  registered with artifact retention disabled regardless of producer metadata.
- Run events retain compact tool evidence only. Trusted complete redacted tool
  results are stored as gzip artifacts for seven days, remain outside SSE,
  require workspace data-read authorization, return `Cache-Control: no-store`,
  and create an audit event when viewed.
  See [Tool Result Artifacts](/docs/design-docs/tool-result-artifacts.md) for the
  storage, idempotency, and access invariants.

## Boundary Notes

- Password signup creates the user account only; it does not create or attach a workspace.
- Workspace membership, audit-log access, target mutation, MCP mutation, tool mutation, Target Insights mutation, and AI settings mutation are permission-gated at the control-plane boundary.
- External integration bot calls use an external integration client token plus `x-acornops-external-user-id`; the resolved `external_integration` credential is default-deny and can only receive `read_workspace_data`, `create_sessions`, and `create_read_only_runs` when allowed by the linked user's workspace role. Implementor-facing endpoint details live in [external-integration-bot-endpoints.md](external-integration-bot-endpoints.md).
- External webhook route connect/status calls are the narrow exception for outgoing webhook setup. `POST /api/v1/external-integrations/webhook-routes/connect` returns only subscriptions created by the linked AcornOps user for the submitted delivery URL where the user still has `permissions.manage_webhooks`; each successful connect rotates the matching signing secrets and returns them once. `GET /api/v1/external-integrations/webhook-routes/status` refreshes live state and must never return signing secrets.
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
