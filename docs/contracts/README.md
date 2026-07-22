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
- OIDC admission evaluates verified ID-token claims and subject-bound UserInfo claims before account or identity-link mutation; conflicting values fail closed.
- Browser logout revokes the current session before any provider redirect and returns only an AcornOps path to the console. ID tokens and provider logout URLs never cross the logout JSON response.
- RP-initiated logout handoffs and callback states are single-use Redis records. Provider logout failure never restores the local session.
- List responses that paginate use `{ items, nextCursor? }`.
- The workspace approval inbox additionally requires `pendingCount`, the workspace-scoped total of pending target-tool and workflow-gate approvals before pagination and independently of the requested list filter.
- Workspace audit filters expose `objectType`, `object`, and `operation`; `operation` is `read` or `write`.
- Audit events keep structured object details instead of forcing agents to reconstruct them from free text.
- Roles with `permissions.manage_mcp` may mutate MCP server configuration.
- Roles with `permissions.manage_tools` may mutate MCP per-tool enablement and non-Target-Insights built-in tool settings.
- Kubernetes clusters and VMs own their target-scoped MCP servers, skills, and tools through the target's generic agent. Target capability routes remain distinct from workspace Agent capability routes.
- Workspace specialist Agents own Agent-scoped MCP and skill installations;
  Cluster and VM default Agents retain distinct target-scoped capabilities.
  Catalog imports are MCP-only, return secret-free DTOs, and never accept a
  browser-supplied target type as authoritative.
- The control plane owns code-defined workspace-native tools. `manage_agents`
  grants or revokes them on specialists without `manage_mcp`. Their reviewed
  mappings authorize workflows, while invocation scope is declared per tool.
  `reports.pdf.generate` supports workflows and target chat; it executes in the
  control plane without crossing a target adapter. Direct Agent runs reject
  workspace-native tools. PDF artifact creation is read-only-run safe but
  write-audited. Execution snapshots expose workspace-native functions through
  provider-safe aliases in `platform_functions`; `native_tools` and gateway JWT
  `allowed_native_tools` remain reserved for provider-native capabilities such
  as `web_search`.
- Cluster Tools lists every code-defined workspace-native tool whose invocation
  scopes include `target_chat`. These entries are enabled, non-configurable,
  marked `origin=platform_native`, and derive from the same registry used by
  target-chat runtime resolution. MCP and Skills remain in their dedicated
  target inventories; internal model-only helpers are not user-visible tools.
- Catalog browsing is destination-first: Agent and target surfaces provide one Add MCP server action with Browse registries and Connect by URL choices. Destination-bound catalog links retain their Agent or target until installation; destination-less `/catalog` links remain valid but require an explicit destination.
- MCP registry management requires `manage_catalog_sources`. Source lists expose whether workspace-managed registries are permitted and the currently supported direct route. Deployment-managed registries are configuration-read-only but may be synchronized; workspace-managed registries may be added, probed, edited, enabled or disabled, synchronized, and deleted.
- Source update authentication is write-only and tri-state: omission preserves the current credential, `none` removes it, and bearer/custom-header replacement requires a new credential. Source lifecycle audit events exclude credentials, headers, and URL query values. Disabling or deleting a registry never removes an installed MCP server or its pinned provenance.
- Workflow mutations require a unique, non-empty `agentIds` specialist set. One
  selected Agent runs directly; two or more are AcornOps-coordinated. Responses
  derive internal routing and `executionMode`; the strict request schema rejects
  all unknown fields with the standard invalid-request response.
- Manual workflow policy defaults are server-owned. The console may send the
  selected `restrictionMode` and semantic subset, while omitted mode, context,
  permissions, and approvals default to read-only workspace metadata access.
  `ASSISTANT_MAX_RUNTIME_MS` is the only execution limit and
  `TARGET_CHAT_REPORT_RETENTION_DAYS` is the only workflow and target-chat PDF
  retention policy. Mutations reject per-workflow timing fields; responses and
  workflow options expose the effective deployment values.
- Virtual-machine registration and key rotation preserve their response shape,
  but generated install instructions use the validated
  `CONTROL_PLANE_BASE_URL` and a literal heredoc so credential values are not
  expanded by the operator shell.
- Selected Agents jointly bound the workflow semantic capability ceiling.
  `restrictionMode=inherit` resolves their current combined ceiling and
  requires an empty semantic list. `restrictionMode=restrict` uses an explicit
  subset, including an intentionally empty subset. Stored definitions always
  contain the final restriction field, and mutations reject unknown policy fields.
  Readiness requires active, reviewed exact mappings from the selected set, and
  later Agent disablement or review loss blocks future runs without changing
  pinned runs.
- Workflow capability preview uses the same workspace-data and run-creation
  authorization as launch. It reports semantic capabilities separately from
  direct attachments, evaluates eligible target candidates from one snapshot,
  and resolves an exact selected target through the same target-tool grant
  intersection used by execution bootstrap. Preview is read-only and bounded:
  it creates no session, execution, run, approval, or audit record and exposes
  no credentials, URLs, headers, schemas, arguments, private connection state,
  or internal coordinator identity. Dispatch always recompiles and its public
  `compiledAccessScope` is authoritative.
- `credentialMode` is explicit installation metadata with values `none`,
  `workspace`, or `individual`. Workspace mode resolves one installation-owned
  service or bot credential; individual mode resolves only the current user's
  credential. Target and Agent installations never share credentials.
- Connection `GET`, `PUT`, `DELETE`, and `POST .../connection/verify` routes
  preserve their destination-specific paths and expose only `serverId`,
  `credentialMode`, `status`, `managementScope`, `canManage`, installation-derived
  `authType`, and the next connect or verify action.
- Connect, verify, and disconnect events are audited without credentials.
  Service-identity runs may use workspace credentials and fail with
  `MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED` when individual ownership requires a
  human principal.
- Target-message, direct-Agent-run, and workflow-message `409` responses expose
  `details.readinessFailures[].{serverId,toolName,code,action?}`. The structured
  entries are allow-listed and never contain credentials, headers, URLs, user
  IDs, or connection snapshots. Connection missing, connection error, and
  credential-snapshot tool absence use `MCP_CONNECTION_REQUIRED` as the
  public recovery category; service principals, unavailable installations, and
  disabled remote MCP retain their distinct bounded codes.
- Readiness preserves the built-in bridge trust boundary: enabled tools require
  matching server and tool identities, trusted built-ins do not require remote
  MCP review or credential connection snapshots, and remote tools remain
  review-gated.
- Workspace creation atomically commits the current starter automation bundle.
  A completed installation remains a tombstone, so deleting starter definitions
  does not recreate them; startup performs no pre-release repair or upgrade.
- Public Agent APIs contain specialists only. Manager creation or configuration
  fails with `MANAGER_SYSTEM_OWNED`, and direct access to system-owned
  coordination records returns 404. Public Workflow, compiled-scope, audit,
  search, and trace DTOs never expose an internal coordinator ID.
- Coordinated execution detail exposes only a bounded `coordination` summary:
  child capability, target, selected specialist, status, and sanitized failure.
  It excludes prompts, compiled scopes, results, credentials, tool arguments,
  and internal coordinator identity. Parent cancellation cascades to active
  delegated child runs.
- Visible template-origin Agents and workflows are system-provided definitions. Workspace managers may change their availability, supported external bindings, or delete them; definition edits and version restore require a duplicated manual draft. Agent deletion reports dependent workflows until those dependencies are removed.
- The automation-template response exposes install mode, installation status, setup steps, blocker codes, and the installed workflow ID. Workspace provisioning materializes only automatic templates and their required Agents. Opt-in definitions and their exclusive Agents are created only by the idempotent install action, remain paused, and report `needs_setup` until live prerequisites pass.
- AcornOps does not provision a repository-review Agent or workflow and does not maintain provider-specific source-control profiles. A workspace manager creates a specialist Agent, installs and reviews a compatible MCP server through the generic Agent capability routes, then creates a workflow that selects that Agent. When the Agent has no platform semantic capability IDs, run compilation snapshots those reviewed exact attachments directly; platform semantic capabilities still require reviewed routing mappings. Credentialed installations use the same secret-free `mcpRequirements` and mode-aware connection flow as every other user-created Agent attachment.
- Workflow capability previews identify credential recovery by generic MCP server ID, ownership mode, auth type, owning Agent, connection state, and action. They never expose provider-profile identities, endpoint URLs, header configuration, credential values, or individual connection inventories. The console writes a replacement credential through the installation connection route and then recomputes preview readiness.
- Authorized users may duplicate an effective definition into a manual draft without copying runs, sessions, schedules, triggers, activity, or capability installations.
- Workflow schedules always run as their authenticated creator. Schedule create
  and update reject service identities with
  `WORKFLOW_SCHEDULE_USER_PRINCIPAL_REQUIRED`; migration pauses schedules whose
  creators are no longer authorized workspace members.
- Roles with `permissions.manage_target_insights` may mutate Target Insights entries and Target Insights tool settings.
- Roles without the relevant management capability are read-only for that configuration surface.
- Chat and run creation must preserve `sessionPolicy.allowedTools` and `sessionPolicy.writeEnabled`.
- Chat session responses derive `lastRuntimeSelection` from the newest accepted
  run snapshot regardless of its eventual terminal status; empty sessions omit
  it, and message acceptance echoes the runtime frozen on that run.
- Target chat accepts up to eight structured tool or skill references. The
  control plane resolves them against the current target capability set and
  run access mode, freezes qualified identities on the run, and returns
  `ASSISTANT_REFERENCE_INVALID` instead of silently dropping stale references.
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
- Execution-engine dispatch uses `Authorization: Bearer <EXECUTION_ENGINE_DISPATCH_TOKEN>`.
- Target adapters register their live built-in tools against the configured internal bridge URL (the local deployment default is `http://control-plane:8081/internal/v1/mcp`). The server identity comes from the registered target, not a seeded workspace integration.
- Built-in MCP tool calls use `Authorization: Bearer <run-scoped-jwt>` and derive scope from `run-scoped-jwt-claims`.
- The built-in MCP bridge must classify calls as read or write before writing audit events.

## Change Checklist

When changing a route, schema, event, or cross-service field:

1. Update the implementation and OpenAPI source together.
2. Update `docs/contracts/manifest.json` for every counterpart that consumes the surface.
3. Keep this README focused on durable invariants only; do not paste endpoint lists here.
4. Run `npm run contracts:check`.
