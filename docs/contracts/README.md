# Control Plane Contracts

The control plane is the platform contract hub. It owns workspace, target, session, message, and run identity, and it is the only one of the component repos that talks directly to all of the others. Kubernetes clusters and Linux/systemd virtual machines are active target types with explicit lifecycle and inventory APIs where their domains differ.
Machine-readable contract data for this repo lives in `docs/contracts/manifest.json` and is checked alongside this document.

## Dependency Matrix

| Counterpart | Direction | Contract surface |
| --- | --- | --- |
| Management console | control-plane -> management-console | Browser auth/session flow, workspace APIs, target-core routes, Kubernetes cluster APIs, VM APIs, chat session APIs, run status/event APIs, tool catalog APIs, MCP server management APIs |
| Webhook consumers | control-plane -> external HTTP endpoints | Best-effort business event delivery with HMAC signatures and delivery history |
| Execution engine | control-plane -> execution-engine | Run dispatch and cancel APIs |
| Execution engine | execution-engine -> control-plane | Bootstrap, context fetch, run event ingestion, run commit |
| LLM gateway | control-plane -> llm-gateway | Internal MCP admin API and workspace AI provider credential status/write/delete API |
| LLM gateway | llm-gateway -> control-plane | JWKS fetch for run JWT validation, builtin MCP tool bridge |
| K8s agent | k8s-agent -> control-plane | WebSocket handshake, heartbeat, snapshot, `tools/list`, `tools/call` |
| K8s agent | control-plane -> k8s-agent | Handshake response, JSON-RPC tool execution requests |
| VM agent | vm-agent -> control-plane | WebSocket handshake, heartbeat, host snapshot, `tools/list`, `tools/call` |
| VM agent | control-plane -> vm-agent | Handshake response and JSON-RPC tool execution requests |
| Operators | operator -> control-plane | Admin API under `/admin/v1` for break-glass support, quota/plan management, run intervention, target agent operations, and audit search |

## Shared Invariants

- Control-plane-owned IDs are UUIDv4: `workspace_id`, `target_id`, `session_id`, `run_id`, and `message_id`. Consumers must treat them as opaque and echo them unchanged. Cluster-facing APIs expose the same Kubernetes target id as `clusterId`.
- Auth channels are intentionally separate and must not be conflated:
  - browser session cookie for management-console traffic,
  - `EXECUTION_ENGINE_DISPATCH_TOKEN` for control-plane dispatch into execution-engine,
  - `ORCH_SERVICE_TOKEN` for execution-engine callbacks into control plane,
  - `LLM_GATEWAY_ADMIN_TOKEN` / `ADMIN_API_TOKEN` for control-plane <-> llm-gateway admin traffic,
  - run-scoped JWTs minted by control plane for execution-engine <-> llm-gateway runtime traffic and llm-gateway builtin MCP bridge calls into control plane,
  - target agent keys for k8s-agent and vm-agent WebSocket auth,
  - admin bearer tokens for `/admin/v1` only.
- `/admin/v1` accepts admin token descriptors only. Browser sessions, CSRF
  cookies, service tokens, run-scoped JWTs, and agent keys are not valid admin
  credentials.
- Webhook signing uses per-subscription `whsec_...` secrets encrypted at rest. Secrets are returned only once on subscription creation.
- Write tooling is only allowed when all three conditions are true:
  - the agent advertises `write` in `supportedCapabilities`,
  - the tool capability is `write`,
  - the run was requested with `toolAccessMode=read_write`.
- Builtin Kubernetes and VM tools are discovered from their connected agents over `tools/list`, then synchronized into llm-gateway as `source="builtin"` under server name `acornops-cluster-agent` and URL `http://control-plane:8081/internal/v1/mcp`.
- Internal service-to-service transport is HTTP by default and HTTPS/mTLS when the Kubernetes Helm chart sets `internalTransport.tls.enabled=true`. mTLS is transport hardening only; `EXECUTION_ENGINE_DISPATCH_TOKEN`, `ORCH_SERVICE_TOKEN`, `LLM_GATEWAY_ADMIN_TOKEN`, and run-scoped JWT authorization remain required.
- Any breaking contract change here must update the mirrored contract docs in the counterpart repo in the same change.

## Operator Admin Contract

Admin endpoints are disabled unless `CONTROL_PLANE_ADMIN_API_ENABLED=true`.
They are mounted under `/admin/v1`, require `Authorization: Bearer <admin-token>`,
and use `CONTROL_PLANE_ADMIN_TOKENS_JSON` descriptors with lowercase SHA-256
hashes. Production deployments must not configure raw admin tokens. All admin
responses set `Cache-Control: no-store`.

Admin endpoint groups:

- `GET /admin/v1/me`
- `GET /admin/v1/system/readiness`
- `GET /admin/v1/system/config`
- `GET /admin/v1/workspaces`
- `GET /admin/v1/workspaces/{workspaceId}`
- `PATCH /admin/v1/workspaces/{workspaceId}/plan`
- `PATCH /admin/v1/workspaces/{workspaceId}/quotas`
- `GET /admin/v1/users`
- `GET /admin/v1/users/{userId}`
- `POST /admin/v1/users/{userId}/sessions/revoke`
- `POST /admin/v1/workspaces/{workspaceId}/members`
- `PATCH /admin/v1/workspaces/{workspaceId}/members/{userId}/role`
- `DELETE /admin/v1/workspaces/{workspaceId}/members/{userId}`
- `GET /admin/v1/targets`
- `GET /admin/v1/targets/{targetId}/agent`
- `POST /admin/v1/targets/{targetId}/agent/disconnect`
- `POST /admin/v1/targets/{targetId}/agent-key/rotate`
- `GET /admin/v1/runs`
- `GET /admin/v1/runs/{runId}`
- `POST /admin/v1/runs/{runId}/cancel`
- `POST /admin/v1/runs/{runId}/mark-failed`
- `POST /admin/v1/tooling/sync`
- `GET /admin/v1/admin-audit-events`
- `GET /admin/v1/audit-events`

Mutating admin requests require `reason` and write `admin_audit_events`.
Workspace-scoped mutations also write workspace audit events with
`actor.type="admin_token"` and `actor.tokenId`. Admin audit responses and
sanitized run payloads must not expose raw tokens, prompts, message bodies, auth
headers, or tool arguments. `POST /admin/v1/targets/{targetId}/agent-key/rotate`
is the only admin response that returns a secret, and the replacement agent key
is returned once.

Admin workspace plan and quota endpoints consume the deployment-configured
workspace plan catalog. Effective workspace limits are the selected plan plus
nullable per-workspace overrides for members, Kubernetes clusters, and virtual
machines. Plan and quota changes that would put current usage over the
resulting effective limit are rejected before mutation.

## Management Console Public Contract

### Auth and browser session

- The management console authenticates with cookie-backed control-plane sessions and must send requests with `credentials: include`.
- Login entrypoint: `GET /api/v1/auth/oidc/login?return_to=<management-console-url>`.
- Callback entrypoint: `GET /api/v1/auth/oidc/callback`.
- Auth runtime config entrypoint: `GET /api/v1/auth/config`.
- CSRF token entrypoint: `GET /api/v1/auth/csrf`; mutating browser requests with a session cookie must echo the token in `x-csrf-token`.
- Password login entrypoint: `POST /api/v1/auth/password/login`.
- Password signup entrypoint: `POST /api/v1/auth/password/signup`.
- Password email verification entrypoint: `POST /api/v1/auth/password/verify-email`.
- Password verification resend entrypoint: `POST /api/v1/auth/password/resend-verification`.
- Password reset request entrypoint: `POST /api/v1/auth/password/forgot`.
- Password reset completion entrypoint: `POST /api/v1/auth/password/reset`.
- Password change entrypoint for authenticated password-backed users: `POST /api/v1/auth/password/change`.
- Current auth-methods entrypoint: `GET /api/v1/auth/methods`.
- Explicit SSO linking entrypoint for authenticated password-backed users: `POST /api/v1/auth/oidc/link/start`.
- Logout entrypoint: `POST /api/v1/auth/logout`.
- Current-user endpoint: `GET /api/v1/me`.
- Dev-only shortcut outside production: `POST /api/v1/auth/dev-login`.
- `GET /api/v1/me` returns `quota.workspaceMemberships.{used,limit}` for settings visibility.
- OIDC users cannot add a local password after account creation. Password users must explicitly connect SSO from account settings; OIDC login no longer implicitly links to an existing password user by email.
- `GET /api/v1/auth/config` returns `passwordEmailVerificationRequired` and `passwordResetEnabled` so the console can choose the right password auth flows.
- When password email verification is required, signup returns `{ status: "verification_required", email, resendAfterSeconds? }` and does not create a browser session. If the account is created but the initial verification email cannot be delivered, signup returns `EMAIL_DELIVERY_FAILED` with safe `{ email }` details; the account remains pending and clients should offer resend.
- `POST /api/v1/auth/password/login` returns `EMAIL_VERIFICATION_REQUIRED` for pending password accounts and must not create or rotate a session.
- `POST /api/v1/auth/password/verify-email` accepts `{ token }`; valid single-use tokens return `{ user, mode: "password", status: "verified" }` and set the normal session cookie. Invalid or consumed tokens return `EMAIL_VERIFICATION_TOKEN_INVALID`; expired tokens return `EMAIL_VERIFICATION_TOKEN_EXPIRED`.
- `POST /api/v1/auth/password/resend-verification` accepts `{ email }` and always returns an enumeration-safe `{ status: "ok", message, resendAfterSeconds? }` shape for unknown, verified, and pending accounts.
- `POST /api/v1/auth/password/forgot` accepts `{ email }` and always returns an enumeration-safe `{ status: "ok", message, resendAfterSeconds? }` shape for syntactically valid email values. Only password-backed accounts receive reset tokens.
- `POST /api/v1/auth/password/reset` accepts `{ token, password }`; valid single-use tokens update the password hash, verify the account email, consume outstanding reset and verification tokens for that user/email, revoke browser sessions, and return `{ status: "ok" }` without creating a new session. Invalid or consumed tokens return `PASSWORD_RESET_TOKEN_INVALID`; expired tokens return `PASSWORD_RESET_TOKEN_EXPIRED`; policy failures return `PASSWORD_POLICY_VIOLATION`.
- Verification and reset tokens are bearer secrets, are stored only as hashes, and must only be sent over HTTPS outside local development.
- Workspace invitation acceptance returns `EMAIL_VERIFICATION_REQUIRED` when the signed-in password account email matches the invite but is still pending verification.

### Workspace, target, and cluster APIs consumed by management console

- `GET /api/v1/workspaces`
- `POST /api/v1/workspaces`
- `GET /api/v1/workspaces/{workspaceId}`
- `DELETE /api/v1/workspaces/{workspaceId}`
- `GET /api/v1/workspaces/{workspaceId}/members`
- `GET /api/v1/workspaces/{workspaceId}/audit-log`
- `GET /api/v1/workspaces/{workspaceId}/invitations`
- `POST /api/v1/workspaces/{workspaceId}/invitations`
- `DELETE /api/v1/workspaces/{workspaceId}/invitations/{invitationId}`
- `GET /api/v1/workspace-invitations/{token}`
- `POST /api/v1/workspace-invitations/{token}/accept`
- `POST /api/v1/workspaces/{workspaceId}/members`
- `PATCH /api/v1/workspaces/{workspaceId}/members/{userId}`
- `DELETE /api/v1/workspaces/{workspaceId}/members/{userId}`
- `GET /api/v1/workspaces/{workspaceId}/ai-settings`
- `PATCH /api/v1/workspaces/{workspaceId}/ai-settings`
- `PUT /api/v1/workspaces/{workspaceId}/ai-provider-credentials/{provider}`
- `DELETE /api/v1/workspaces/{workspaceId}/ai-provider-credentials/{provider}`
- `GET /api/v1/workspaces/{workspaceId}/targets`
- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/metrics/history`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/metrics/history`
- `POST /api/v1/workspaces/{workspaceId}/kubernetes-clusters`
- `PATCH /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}`
- `DELETE /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}`
- `POST /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/rotate-agent-key`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/pods/{namespace}/{podName}/logs`
- `GET /api/v1/workspaces/{workspaceId}/virtual-machines`
- `POST /api/v1/workspaces/{workspaceId}/virtual-machines`
- `GET /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}`
- `PATCH /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}`
- `DELETE /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}`
- `POST /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/rotate-agent-key`
- `GET /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/resources`
- `GET /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/findings`
- `GET /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/metrics/history`
- `GET /api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/logs`

`GET /api/v1/workspaces/{workspaceId}/targets` accepts optional `q`, `limit`, `cursor`, and `targetType` query parameters. `targetType` must be `kubernetes` or `virtual_machine`; invalid values return `400 VALIDATION_ERROR` instead of widening the query.

Workspace responses expose server-owned authorization fields:

- `currentUserRole`
- `permissions.read_workspace_data`
- `permissions.read_members`
- `permissions.read_audit_log`
- `permissions.delete_workspace`
- `permissions.manage_members`
- `permissions.manage_targets`
- `permissions.manage_mcp`
- `permissions.manage_tools`
- `permissions.manage_ai_settings`
- `permissions.manage_agent_keys`
- `permissions.manage_webhooks`
- `permissions.create_sessions`
- `permissions.create_read_only_runs`
- `permissions.create_read_write_runs`
- `permissions.read_target_logs`
- `clusterCount`
- `memberCount`
- `plan.{key,name}` where the only active key is currently `default`
- `quota.members.{used,limit}`
- `quota.kubernetesClusters.{used,limit}`
- `quota.virtualMachines.{used,limit}`

Workspace summaries must redact operational counts for roles without `permissions.read_workspace_data`; for `auditor`, `clusterCount` is always `0` while `memberCount` remains available as member context. Workspace quota limits remain visible, but operational quota `used` counts are redacted to `0` for users without `permissions.read_workspace_data`. Member counts and `quota.members.used` require `permissions.read_members`.

Quota failures on workspace creation, member add, invitation accept, Kubernetes cluster registration, and virtual machine registration return `409 QUOTA_EXCEEDED` with `details.{quotaKey,used,limit}`. `quotaKey` is `workspaceMemberships` for the number of workspaces a user has joined, `workspaceMembers` for the number of members in a workspace, `kubernetesClusters`, or `virtualMachines`. Invitation acceptance quota failures leave the invitation pending.

Workspace membership responses are server-owned and include:

- `userId`
- `email`
- `displayName`
- `role`
- `roleTemplate?`
- `source`

`GET /api/v1/workspaces/{workspaceId}/roles` returns the deployment-supported role template catalog for the workspace. The catalog is deployment-wide, read-only, and includes `key`, `displayName`, `description`, `kind`, `capabilities`, `protected`, and `sortOrder`. Workspace summaries may include `currentUserRoleTemplate`; memberships and invitations may include `roleTemplate`. Clients must use these fields for labels and role selection instead of duplicating role/capability logic.

`GET /api/v1/workspaces/{workspaceId}/ai-settings` returns the workspace AI assistant default provider/model, deployment-allowed providers/models, and per-provider configured status to workspace members. It never returns API key values or internal secret names. `PATCH /ai-settings` updates `{defaultProvider,defaultModel}` and requires `permissions.manage_ai_settings`. `PUT /ai-provider-credentials/{provider}` accepts write-only `{apiKey}` to save or rotate a workspace provider credential and validates deployment provider policy. `DELETE /ai-provider-credentials/{provider}` removes a supported provider credential even if that provider is no longer deployment-allowed, so stale secrets can be cleaned up after policy changes. AI settings and credential mutations require `permissions.manage_ai_settings` and write workspace audit events. Assistant run creation resolves provider/model from workspace AI settings, stores that provider/model on the run snapshot, and rejects before dispatch when the selected provider/model is not deployment-allowed or the selected provider has no workspace credential.

Owners can manage all member roles. Other roles with `permissions.manage_members` can directly assign, update, or remove non-protected members. `owner` is always present, protected, and required; the built-in `auditor` role is protected when enabled. A non-owner assigning or modifying a protected role returns `PROTECTED_ROLE_REQUIRES_OWNER`. Membership and invitation roles must exist in the deployment-supported catalog or the API returns `ROLE_NOT_SUPPORTED`. Any role update or removal that would leave a workspace with no owner must return `LAST_OWNER` and must not mutate membership.

Workspace invitations are token-backed join links. Creating an invitation returns the raw `token` once; the control plane only stores `token_hash`. Roles with `permissions.manage_members` can list pending invitation metadata and revoke pending invitations. Accepting an invitation requires an authenticated user whose email matches the invite email, then creates the workspace membership.

`GET /api/v1/workspaces/{workspaceId}/audit-log` is cursor-paged and requires `permissions.read_audit_log`. It accepts optional `category`, `eventType`, `actorUserId`, `targetType`, `from`, and `to` filters and returns audit events with `id`, `workspaceId`, `category`, `eventType`, `operation`, `actor`, `target`, `summary`, `metadata`, and `occurredAt`. `operation` is `read` or `write`; deployment-wide audit mode uses it to retain all events, only write events, or no future events. Invalid `category`, blank string filters, invalid date filters, or inverted date ranges return `VALIDATION_ERROR` instead of widening the result set. Audit payloads must not include secrets, raw invite tokens, message bodies, pod log contents, auth headers, or full tool arguments, and metadata is sanitized before persistence. Controller-side lifecycle audit writes are best-effort and log failures so a completed mutation is not reported as failed after side effects have already committed; transaction-bound membership and invitation changes write audit events inside the same database transaction. Retention purges persisted workspace audit events older than `WORKSPACE_AUDIT_RETENTION_DAYS` regardless of `WORKSPACE_AUDIT_LOGGING_MODE`. Tool call audit events record tool identity, source, target, duration, run id when available, and success/failure only. The `auditor` role can read audit logs and members only, not operational workspace data.

Kubernetes cluster registration response must remain:

- `{ cluster, agentKey, installInstructions }`

Agent-key rotation response must remain:

- `{ clusterId, agentKey, keyVersion, installInstructions }`

Virtual machine registration response must remain:

- `{ virtualMachine, agentKey, installInstructions }`

Virtual machine agent-key rotation response must remain:

- `{ vmId, agentKey, keyVersion, installInstructions }`

VM registration accepts `name`, optional `hostname`, `osFamily = "linux"`, `serviceManager = "systemd"`, and bounded `allowedLogSources`. VM updates accept `name`, `hostname`, and `allowedLogSources`; OS family and service manager are immutable for the initial Linux/systemd target model.

Pod log reads are backed by the connected Kubernetes agent `get_resource_logs` tool. They require `permissions.read_target_logs`, respect the cluster namespace include/exclude scope, and return `{ name, namespace, container, logs, tailLines, previous, fetchedAt }`.

`installInstructions.command` is owned by the control plane. Management consoles must display it as returned instead of hardcoding chart paths, release names, or Helm value names.

Kubernetes cluster updates accept `name`, `namespaceInclude`, and `namespaceExclude`. Namespace scope changes take effect for control-plane authorization and regenerated install instructions immediately. If the Kubernetes agent is connected and supports `config/update_namespace_scope`, the control plane pushes the new scope over the existing WebSocket channel and the next snapshot uses it without an agent restart. Disconnected agents receive the persisted scope in the next handshake response.

`GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}` returns cluster metadata, `writeConfirmationPolicy`, `latestSnapshot.{clusterId,workspaceId,timestamp}`, and `summary.{resourceCount,findingCount,criticalFindingCount,namespaceCount,nodeCount,resourceFamilyCounts,resourceKindCounts}`. It must not return full `latestSnapshot.data` to the browser.

Snapshot-derived management-console data is exposed through bounded list APIs:

- `GET /api/v1/workspaces/{workspaceId}/investigations`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/resources`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/findings`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/metrics/history`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/metrics/history`

Paged resource, finding, and investigation APIs return `{ items, nextCursor? }`, accept `limit`, `cursor`, and `q` where search is supported, and apply exact filters before pagination. Cursor reuse with different query/filter state returns `400`. The control plane persists the raw agent snapshot append-only, then materializes latest resources, findings, and summary counts at ingest for browser-facing list APIs. Metrics history endpoints continue to read append-only snapshot history.

VM host snapshots are persisted through the same target snapshot history and materialized into target inventory/finding tables. Browser-facing VM resource and finding APIs return `{ items, nextCursor? }`; VM metrics return bounded history points; VM logs are read live through the connected VM agent with `permissions.read_target_logs` authorization and return bounded entries only.

### Tool catalog and MCP management APIs

- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/catalog`
- `PATCH /api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/{toolName}`
- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers`
- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/tools`
- `POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers`
- `PATCH /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}`
- `DELETE /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}`
- `POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/test-connection`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/tools/catalog`

Remote MCP server management is target-scoped. Kubernetes clusters and virtual machines both use the target MCP surface. Kubernetes and VM built-in tools are synchronized from each connected agent and remain capability-tagged. Write-tool availability is driven by the advertised tool capability, target agent capabilities, user permissions, and the requested run `toolAccessMode`; the current VM v1 agent catalog happens to advertise only read tools.

The management console depends on these catalog fields:

- `permissions.canEdit`
- `permissions.editableRoles`
- `servers[].{id,name,url,type,enabled,isSystem,canDelete,canEditConnection,authType,connectionStatus,lastDiscoveryAt,lastDiscoveryError}`
- `servers[].toolCounts.{total,enabledConfigured,enabledEffective,writeConfigured,writeEffective}`
- `GET /mcp/servers/{serverId}/tools` returns paged tool rows with `{name,description,capability,version,source,enabledConfigured,enabledEffective,effectiveDisabledReason}`

Mutation policy exposed to the management console:

- Roles with both `permissions.manage_tools` and `permissions.manage_mcp` may mutate tool settings and MCP server configuration. Catalog `permissions.editableRoles` is derived from the deployment role templates for display only; `permissions.canEdit` is the authoritative per-user decision.
- Public remote MCP server creation is discovery-first: callers provide connection details and optional non-secret `publicHeaders`, and tool mappings are discovered through the server's `tools/list` endpoint.
- Newly discovered external MCP tools remain disabled until an authorized workspace role reviews and enables them with an explicit capability.
- Roles without both management capabilities are read-only for tool and MCP configuration.

### Chat and run APIs

- `POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions`
- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions`
- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity`
- `POST /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions`
- `DELETE /api/v1/sessions/{sessionId}`
- `GET /api/v1/sessions/{sessionId}/messages`
- `POST /api/v1/sessions/{sessionId}/messages`
- `GET /api/v1/runs/{runId}`
- `GET /api/v1/runs/{runId}/events`
- `GET /api/v1/runs/{runId}/stream`
- `GET /api/v1/runs/{runId}/approvals`
- `POST /api/v1/runs/{runId}/approvals/{approvalId}/decision`
- `POST /api/v1/runs/{runId}/cancel`

Target-scoped session routes resolve targets through the target core. Posting a message starts a troubleshooting run for Kubernetes and virtual machine targets. Write access is capability-driven by target agent registration, tool metadata, user permissions, and requested `toolAccessMode`; the control plane must not synthesize Kubernetes `clusterId` aliases for VM sessions or runs.

Troubleshooting conversations are owner-write and viewer-read. `sessions.created_by` is the conversation owner. `POST /api/v1/sessions/{sessionId}/messages` must return `403 CONVERSATION_OWNER_REQUIRED` when the authenticated user can read the session but did not create it, even if that user has elevated workspace run permissions. Owners still need the existing run creation capability for the requested `toolAccessMode`.

Run mutation policy:

- `owner` and `admin` may create `read_only` and `read_write` runs.
- `operator` may create sessions and `read_only` runs only.
- `viewer` may read existing session and run data but may not create sessions or runs.
- Direct public agent tool-call APIs are not part of this contract; runtime tools execute through run-scoped gateway authorization.

Session listing response must remain cursor-based:

- `{ items, nextCursor? }`
- Each session item includes `targetId`, `targetType`, `createdBy`, and optional `createdByUser.{id,displayName}`. Kubernetes session items also include `clusterId`, which is the same backing target ID.
- Run details and approval replay payloads include `targetId` and `targetType`. Kubernetes payloads also include `clusterId`; non-Kubernetes targets must not receive a synthetic cluster alias.

Recent target chat activity uses `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity?windowSeconds=300`. It requires target read access, not `create_sessions`. The server clamps optional `windowSeconds` from 60 to 3600 seconds and defaults to `TARGET_CHAT_RECENT_ACTIVITY_WINDOW_SECONDS=300`. The response includes `targetId`, `targetType`, `targetName`, `windowSeconds`, `generatedAt`, and `recentActivity[]`. Each activity row includes `sessionId`, `title`, `createdBy`, optional `createdByUser.{id,displayName}`, `lastActivityAt`, optional latest run metadata, optional active run metadata, `hasActiveRun`, `hasRecentWriteCapableRun`, and optional `latestToolAccessMode`.

`POST /api/v1/sessions/{sessionId}/messages` accepts:

- `content`
- `toolAccessMode` in `read_only | read_write`
- `clientMessageId`

and returns:

- `message_id`
- `run_id`

Run event payloads sent over both replay and SSE are shaped as:

- `schema_version`
- `run_id`
- `seq`
- `ts`
- `type`
- `payload`

Current event types emitted by execution-engine and forwarded by control plane:

- `run_progress`
- `run_started`
- `assistant_message_started`
- `assistant_token_delta`
- `tool_call_started`
- `tool_call_completed`
- `tool_approval_requested`
- `tool_approval_approved`
- `tool_approval_rejected`
- `tool_approval_expired`
- `assistant_message_completed`
- `run_failed`
- `run_cancelled`
- `run_completed`

The management console deduplicates on `seq`, so the control plane must preserve sequence numbers exactly.
Cancellation is terminal. Once cancellation is accepted for a run, the control
plane must persist and replay `run_cancelled` as the terminal event and must
ignore later non-terminal execution events such as token deltas, progress,
assistant completion, or run completion. SSE clients must not receive
post-terminal assistant content.

### Webhook APIs

Webhook management is backend/API-only. Webhooks are best-effort: the control plane records each attempted delivery in `webhook_history`, but it does not guarantee retry or eventual delivery.

- `GET /api/v1/workspaces/{workspaceId}/webhooks`
- `POST /api/v1/workspaces/{workspaceId}/webhooks`
- `GET /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}`
- `PATCH /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}`
- `DELETE /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}`
- `GET /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/history`

Mutation policy:

- `owner` and `admin` receive `permissions.manage_webhooks` and may create, update, and delete webhooks.
- `operator` and `viewer` may list subscriptions.
- Roles with `permissions.manage_webhooks` may read webhook delivery history.
- Signing secrets are returned only on create and are omitted from all list/get/history responses.

Create request:

```json
{
  "name": "PagerDuty webhook",
  "url": "https://example.com/acornops/webhook",
  "eventTypes": ["run.completed.v1", "run.failed.v1"],
  "targetId": null,
  "enabled": true
}
```

Webhook payloads are shaped as:

```json
{
  "id": "evt_...",
  "type": "run.completed.v1",
  "occurredAt": "2026-05-05T12:00:00.000Z",
  "workspaceId": "4b930d98-add9-4924-ab26-3c16d96ec373",
  "clusterId": "5b006e4c-509c-458a-9f02-5aafbdc01ade",
  "targetId": "5b006e4c-509c-458a-9f02-5aafbdc01ade",
  "targetType": "kubernetes",
  "subject": {
    "type": "run",
    "id": "..."
  },
  "data": {}
}
```

Webhook signing headers:

- `AcornOps-Event-Id`
- `AcornOps-Event-Type`
- `AcornOps-Timestamp`
- `AcornOps-Signature`

Signature input is `timestamp + "." + raw_json_body`, signed with HMAC-SHA256 and encoded as `v1=<hex>`.

JavaScript verification example:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyWebhook({ secret, timestamp, rawBody, signature }) {
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const received = signature.replace(/^v1=/, '');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}
```

Webhook event catalog:

- `workspace.created.v1`
- `workspace.deleted.v1`
- `target.registered.v1`
- `target.updated.v1`
- `target.deleted.v1`
- `target.status_changed.v1`
- `agent.connected.v1`
- `agent.disconnected.v1`
- `agent.capabilities_changed.v1`
- `agent.key_rotated.v1`
- `session.created.v1`
- `session.deleted.v1`
- `message.received.v1`
- `run.created.v1`
- `run.started.v1`
- `run.completed.v1`
- `run.failed.v1`
- `run.cancelled.v1`
- `run.cancel_requested.v1`
- `run.tool_approval_requested.v1`
- `run.tool_approval_decided.v1`
- `tool.called.v1`
- `mcp.server.created.v1`
- `mcp.server.updated.v1`
- `mcp.server.deleted.v1`
- `mcp.server.tested.v1`
- `tool.catalog.changed.v1`

The webhook catalog intentionally excludes `assistant_token_delta`, `assistant_message_started`, `assistant_message_completed`, `run_progress`, heartbeats, and raw snapshot events.

Approval webhook events are channel-agnostic notifications. Browser and bot adapters may render approval buttons from their payloads, but they must call the public decision API as an authenticated AcornOps user. Backend approval enforcement happens in execution-engine before write tool execution.

## Run Approvals

Write-tool confirmation is represented as a control-plane resource, not frontend-local state.

Public approval endpoints:

- `GET /api/v1/runs/{runId}/approvals`
- `POST /api/v1/runs/{runId}/approvals/{approvalId}/decision`

Decision body is `{ "decision": "approved" | "rejected" }`. Approval requires `create_read_write_runs`; the original requester may reject their own pending approval. The first decision wins. Repeating the same decision is idempotent, while a conflicting decision or an already expired approval returns conflict with the current approval.

Run status includes:

- `queued`
- `dispatching`
- `running`
- `waiting_for_approval`
- `completed`
- `failed`
- `cancelled`
- `cancelling`

`waiting_for_approval` means execution-engine has persisted a continuation and released its worker slot. Approval, rejection, expiry, or cancellation redispatches the run so the engine can resume from stored state.

## Execution-Engine Contract

Transport may be plaintext HTTP by default or HTTPS/mTLS when enabled by Helm
`internalTransport.tls`. The authorization contract does not change.

### Control plane -> execution engine

Control plane must send `Authorization: Bearer <EXECUTION_ENGINE_DISPATCH_TOKEN>` to all execution-engine dispatch endpoints. Execution-engine rejects missing or invalid dispatch tokens with `401`.

The control plane dispatches runs to execution-engine with:

- `POST /api/v1/runs`
- `POST /api/v1/runs/{run_id}/cancel`

Run dispatch request body:

- `contract_version`
- `run_id`
- `workspace_id`
- `target_id`
- `target_type`
- `session_id`
- `message_id`
- `requested_at`

Expected dispatch semantics:

- `202` means accepted or already active,
- `200` means idempotent replay of a terminal run,
- `409` means existing `run_id` scope mismatch,
- `429` means engine overloaded.

### Execution engine -> control plane

Execution-engine must send `Authorization: Bearer <ORCH_SERVICE_TOKEN>` to:

- `POST /internal/v1/runs/{runId}/bootstrap`
- `POST /internal/v1/runs/{runId}/approvals`
- `GET /internal/v1/runs/{runId}/continuation`
- `POST /internal/v1/runs/{runId}/approvals/{approvalId}/execution-started`
- `POST /internal/v1/runs/{runId}/approvals/{approvalId}/execution-finished`
- `DELETE /internal/v1/runs/{runId}/continuation`
- `GET /internal/v1/sessions/{sessionId}/context?run_id=<runId>`
- `POST /internal/v1/runs/{runId}/events`
- `GET /internal/v1/runs/{runId}/event-cursor`
- `POST /internal/v1/runs/{runId}/commit`

Bootstrap response contract:

- `contract_version`
- `scope.{workspace_id,target_id,target_type,session_id,run_id,user_id}`
- `policy.{max_runtime_ms,max_output_tokens,budget_cents,max_steps,max_tool_calls,max_duplicate_tool_calls}`
- `context.{endpoint,max_context_tokens}`
- `llm.{provider,model,temperature,mode,gateway.{url,token,request_timeout_ms}}`
- `tools.{tool_registry_version,allowed_tools,tool_specs,gateway.{url,token},confirmation_required_for_write,approval_timeout_seconds}`
- `routing`
- `tracing`

Context response contract:

- `messages[]` with `{role, content}`
- `summaries[]`
- `attachments[]`

Event ingestion contract:

- `POST /internal/v1/runs/{runId}/events`
- body is `{ events: RunEvent[] }`
- each event includes `schema_version=1`, `run_id`, `seq`, `ts`, `type`, `payload`
- `GET /internal/v1/runs/{runId}/event-cursor` returns `{ latestSeq }` from persisted run events, or the runtime replay buffer when persistence is disabled, so resumed execution can continue monotonic event sequencing

Commit contract:

- `status` in `completed | failed | cancelled`
- optional `assistant_message.{content,format}`
- `usage.{input_tokens,output_tokens,tool_calls}`
- `timing.{started_at,ended_at}`

Durable approval interrupt contract:

- `POST /internal/v1/runs/{runId}/approvals` creates the pending approval and stores a `run_continuations` row containing the resumable ReAct state and pending tool call.
- Continuations must not store gateway tokens or other credentials. Resume always calls bootstrap again and revalidates tool allow-list and capability.
- `GET /internal/v1/runs/{runId}/continuation` returns the stored continuation plus current approval state after approval, rejection, or expiry.
- `POST /execution-started` claims the approved write for at-most-once execution. If a prior attempt was already executing, the control plane returns `execution_status=unknown`, and execution-engine must fail closed without retrying the write.
- `POST /execution-finished` persists the original write result immediately after the tool call returns.
- `DELETE /internal/v1/runs/{runId}/continuation` consumes continuation after the resumed loop incorporates the result.
- Before emitting resume events, execution-engine must seed its event sequence from `GET /internal/v1/runs/{runId}/event-cursor` and any higher local durable outbox cursor; resumed `tool_approval_*` and tool result events must not reuse earlier sequence numbers.

## LLM-Gateway Contract

Transport may be plaintext HTTP by default or HTTPS/mTLS when enabled by Helm
`internalTransport.tls`. The admin token, run-scoped JWTs, and JWKS validation
remain required in both modes.

### Control plane -> llm-gateway admin API

The control plane manages llm-gateway registry state with `Authorization: Bearer <ADMIN_API_TOKEN>` against:

- `GET /api/v1/internal/llm/provider-credentials?workspace_id=<workspaceId>`
- `PUT /api/v1/internal/llm/provider-credentials/{provider}`
- `DELETE /api/v1/internal/llm/provider-credentials/{provider}?workspace_id=<workspaceId>`
- `GET /api/v1/internal/mcp/servers`
- `GET /api/v1/internal/mcp/tools`
- `PATCH /api/v1/internal/mcp/tools/{tool_name}`
- `POST /api/v1/internal/mcp/servers`
- `PATCH /api/v1/internal/mcp/servers/{server_id}`
- `POST /api/v1/internal/mcp/servers/{server_id}/test`
- `DELETE /api/v1/internal/mcp/servers/{server_id}`

Provider credential status/write/delete scope is workspace-only. LLM provider
secret names are `{provider}_api_key` and tenant scope is
`{"workspace_id":"<workspaceId>"}`. Target-scoped secrets remain reserved for
MCP/server credentials. The provider credential status response includes
`provider`, `configured`, and `enabled`, and must not include key values,
ciphertexts, or secret names.

MCP registry scope is carried as required `workspace_id`, `target_id`, and
`target_type` query/body fields. Control plane depends on llm-gateway preserving
tool fields:

- `name`
- `mcp_server_url`
- `timeout_ms`
- `description`
- `capability`
- `version`
- `source`
- `input_schema`
- `enabled`

The control plane sources that bearer token from its `LLM_GATEWAY_ADMIN_TOKEN` environment variable. The wire contract, however, is just the shared admin token value.

### llm-gateway -> control plane

llm-gateway depends on two control-plane surfaces:

1. `GET /api/v1/auth/jwks.json`
   - used to validate run-scoped JWTs,
   - token `iss` must match `GATEWAY_TOKEN_ISSUER`,
   - token `aud` must match `GATEWAY_TOKEN_AUDIENCE`,
   - claims include `run_id`, `workspace_id`, `target_id`, `target_type`, `session_id`, and `permissions`.
   - `permissions` includes `allowed_providers`, `allowed_models`, `allowed_tools`, optional `allowed_tool_operations`, and `max_output_tokens`.
   - `allowed_tool_operations` maps tool names to `read` or `write` for workspace audit classification; missing or malformed entries are treated as `write` by the control plane.

2. `POST /internal/v1/mcp/tools/call`
   - used when builtin target tools are routed through the control plane,
   - requires `Authorization: Bearer <run-scoped-jwt>`,
   - scope source is `run-scoped-jwt-claims`; control plane derives workspace, target, run, session, and allowed-tool scope from the JWT claims,
   - request body is `{ name, arguments }`,
   - response must remain MCP-style `{ content: [{ type: "text", text: string }], isError: boolean }`.

The builtin server identity must remain:

- `server_name = acornops-cluster-agent`
- `server_url = http://control-plane:8081/internal/v1/mcp`

because control plane uses those values to detect and reconcile the builtin tool bridge.

## K8s-Agent Contract

### Connection and handshake

Accepted WebSocket paths:

- `/api/v1/agent/connect`
- `/agent/v1/connect`

Agent authentication:

- `x-agent-key` header, or
- `params.agentKey` inside the handshake request

Version metadata:

- `x-agent-version` header
- `params.version` / `params.agentVersion`

Handshake request is JSON-RPC `lifecycle/handshake` with:

- `agentKey`
- `version`
- `agentVersion`
- `targetId`
- `targetType = "kubernetes"`
- `agentType = "k8s_agent"`
- `supportedCapabilities`
- `clusterFeatures.metricsApiAvailable`
- `clusterFeatures.rbacMode`

Handshake success response includes:

- `workspaceId`
- `targetId`
- `targetType`
- `sessionPolicy.allowedTools`
- `sessionPolicy.writeEnabled`
- `config.snapshotInterval`
- `config.maxSnapshotBytes`
- `config.namespaceScope.{include,exclude}`

Kubernetes agents must treat the handshake response as authoritative and reject it if `targetId` does not match the configured cluster target id or if `targetType` is not `kubernetes`.

The control plane may also call `config/update_namespace_scope` over the connected agent WebSocket. Agents must update their in-process namespace scope for collectors and tool namespace guards, return `{ namespaceScope, rbacMode }`, and continue using the persisted handshake scope after reconnects.

Current builtin tool names advertised back to the agent:

- `list_resources`
- `get_resource`
- `get_resource_logs`
- `restart_workload`
- `scale_workload`
- `simulate_patch`
- `apply_remediation`

### Agent -> control plane notifications

- `lifecycle/heartbeat` with `timestamp`
- `notify/snapshot` with `timestamp` and `data`

Snapshot payload branches persisted and exposed to the management console:

- `metrics`
- `resources`
- `events`

### Control plane -> agent requests

The control plane uses JSON-RPC requests over the same WebSocket:

- `tools/list`
- `tools/call`

`tools/list` must return tool objects with:

- `name`
- `description`
- `capability`
- `input_schema`
- `timeout_ms`
- `version`
- `deprecated`

`tools/call` is sent as params:

- `name`
- `arguments`

The agent remains the implementation owner for builtin tool schemas and runtime behavior, while the control plane owns how those tools are registered, filtered, and exposed to the rest of the platform.

## VM-Agent Contract

The VM agent uses the same outbound WebSocket paths, agent-key authentication, heartbeat, snapshot, `tools/list`, and `tools/call` JSON-RPC envelope as the Kubernetes agent. VM handshakes must set `targetType = "virtual_machine"` and `agentType = "vm_agent"`.

VM handshake metadata includes:

- `agentKey`
- `agentId`
- `agentVersion`
- `targetId`
- `targetType = "virtual_machine"`
- `agentType = "vm_agent"`
- `supportedCapabilities`
- `osFamily = "linux"`
- `serviceManager = "systemd"`

VM handshake success responses include the same target-scoped session policy envelope as Kubernetes handshakes:

- `workspaceId`
- `targetId`
- `targetType`
- `sessionPolicy.allowedTools`
- `sessionPolicy.writeEnabled`
- `config.snapshotInterval`
- `config.maxSnapshotBytes`

The initial Linux/systemd VM agent advertises read/logs/MCP/chat/systemd/linux capabilities and exposes this read-only tool catalog:

- `get_host_summary`
- `list_processes`
- `get_process`
- `list_services`
- `get_service_status`
- `get_logs`
- `search_logs`
- `check_port`
- `list_listening_ports`

VM snapshots include `host`, `resources.processes`, `resources.services`, `resources.ports`, `findings`, and `metrics`. The control plane materializes those snapshots into target inventory, findings, summary, and metrics history without invoking Kubernetes-specific repository paths.
