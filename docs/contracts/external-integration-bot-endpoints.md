# External integration bot endpoints

This document is the implementation contract for an external chatbot that calls
AcornOps on behalf of a linked external user.

It complements [external-integration-account-link-endpoints.md](external-integration-account-link-endpoints.md),
which covers how an external user links their chat identity to an AcornOps
account.

## Configuration

The bot needs:

- `ACORNOPS_API_BASE_URL`, for example `https://api.acornops.dev`.
- An external integration client token registered through the control-plane
  `EXTERNAL_INTEGRATION_CLIENTS_JSON` token hash descriptors.
- A stable external user id, sent as `externalUserId` during linking and as
  `x-acornops-external-user-id` during bot API calls.

The client token is not a browser session, admin token, run token, or
orchestrator service token.

## Authentication

For linked-account bot calls, send both headers:

```http
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
```

`x-acornops-external-user-id` must be the same stable external user id that was
linked through the account-link flow.

If the external user is not linked, AcornOps returns `401`. A caller can use the
account-link flow below to create a link URL.

## Account Link Flow

Callers can resolve whether an external user is linked before calling
operational endpoints:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/external-integrations/resolve
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
Content-Type: application/json
```

```json
{
  "externalUserId": "external-user-id"
}
```

Linked response:

```json
{
  "status": "linked",
  "user": {
    "id": "acornops-user-id",
    "email": "user@example.com",
    "displayName": "User Name"
  },
  "link": {
    "linkedAt": "2026-06-09T00:00:00.000Z",
    "lastAuthenticatedAt": "2026-06-09T00:00:00.000Z",
    "expiresAt": "2026-07-09T00:00:00.000Z"
  }
}
```

Unlinked response:

```json
{
  "status": "unlinked"
}
```

To create a link URL for an unlinked user:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/external-integrations/link
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
Content-Type: application/json
```

```json
{
  "externalUserId": "external-user-id"
}
```

Response:

```json
{
  "linkUrl": "https://console.acornops.dev/integrations/external/link?token=intlink_...",
  "expiresAt": "2026-06-09T00:00:00.000Z"
}
```

Treat `linkUrl` as a short-lived bearer secret. Do not log the full URL or token.

## External Webhook Routes

Bots that generate a stable delivery URL per external user or destination can
ask the linked AcornOps user to create workspace webhook subscriptions for that
URL. After setup, the bot can claim current subscription metadata with:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/external-integrations/webhook-routes/connect
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
Content-Type: application/json
```

```json
{
  "deliveryUrl": "https://bot.example.com/acornops/webhooks/routes/route-token"
}
```

AcornOps returns only subscriptions created by the linked AcornOps user for that
exact delivery URL where the user still has `permissions.manage_webhooks`. Each
successful connect rotates the matching webhook signing secrets and returns the
fresh `signingSecret` values once in the connect response.

Use status to refresh live state without secret material:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/external-integrations/webhook-routes/status?deliveryUrl={url-encoded-delivery-url}
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
```

Status responses use `unconfigured`, `configured`, or `connected`. They include
current workspace, event, enabled, and webhook identifiers, but never include
signing secrets.

## Authorization Model

Bot calls are default-deny. The external integration credential can only use
these default AcornOps workspace capabilities unless the registered client
descriptor changes them with `allowedCapabilities`:

- `read_workspace_data`
- `create_sessions`
- `create_read_only_runs`

Deployments that want an integration to request write-capable troubleshooting
runs or active read-write/approval-gated Workflows may add
`create_read_write_runs` to that client's `allowedCapabilities`.
The linked AcornOps user must still explicitly grant that capability for each
workspace, and the user's workspace role must also include it.

Those bot capabilities are intersected with the linked AcornOps user's real
workspace role and the user-approved grant for each workspace. The bot never
gets more access than the linked user has, and a workspace without a grant is
hidden or denied to the bot.

Practical examples:

- A linked `viewer` can read workspace and target operational data, but cannot
  create assistant sessions, only in workspaces the user granted.
- A linked `operator`, `admin`, or `owner` can create read-only assistant
  sessions and read-only runs when the workspace grant includes those
  capabilities.
- A linked user whose workspace role includes `create_read_write_runs` can
  request read-write assistant runs and eligible Workflows only when the
  integration client ceiling and workspace grant also include
  `create_read_write_runs`.
- A linked `auditor` cannot read operational workspace or target data.

Denied to the bot even for owners:

- workspace/member/audit/settings management
- logs
- approval decisions for browser-created executions, other integration
  links/clients, delegated specialist children, schedules, and system triggers
- run cancellation
- session deletion
- target registration, updates, deletion, and agent-key rotation
- MCP/tool/webhook/AI settings mutations

## Common Response Shapes

Paged list endpoints return:

```json
{
  "items": [],
  "nextCursor": "optional-cursor"
}
```

When `nextCursor` is present, pass it back as `?cursor={nextCursor}` for the next
page.

Errors use:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "No access to workspace data",
    "retryable": false
  }
}
```

Common statuses:

- `200` success for reads.
- `201` session created.
- `202` assistant run accepted.
- `400` invalid payload, invalid cursor, unsupported target, or AI provider
  configuration issue.
- `401` missing/invalid client token or unlinked external user id.
- `403` linked user or bot allowlist does not permit the action.
- `404` object not found or not accessible.

## Allowed Endpoints

All endpoints below require:

```http
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
```

These endpoints cover workspace and target reads, target-scoped assistant
troubleshooting runs, and active Workflows. Read-write troubleshooting runs,
read-write Workflows, and approval-gated Workflows require explicit
`create_read_write_runs` opt-in in the registered client descriptor, the linked
user's workspace grant, and the linked user's workspace role. External
integrations cannot create, edit, schedule, cancel, or resume Workflows.

### Workspace Discovery

List workspaces:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces?limit=50&cursor={cursor}&q={search}
```

Get one workspace summary:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}
```

Workspace summary items include:

```json
{
  "id": "workspace-id",
  "name": "Workspace",
  "plan": { "key": "default", "name": "Default" },
  "currentUserRole": "operator",
  "permissions": {
    "read_workspace_data": true,
    "create_sessions": true,
    "create_read_only_runs": true,
    "create_read_write_runs": false,
    "read_target_logs": false
  },
  "clusterCount": 2,
  "memberCount": 0,
  "quota": {
    "members": { "used": 0, "limit": 100 },
    "kubernetesClusters": { "used": 2, "limit": 10 },
    "virtualMachines": { "used": 1, "limit": 10 }
  }
}
```

For bot calls, `memberCount` and `quota.members.used` are redacted because the
bot does not have `read_members`.

### Workflow launches

The bot can list active Workflows that its effective permissions allow:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/workflows
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
```

External integrations only receive workflows that:

- are `active`.
- are permitted by the linked user role, registered client allowlist, and
  user-approved workspace grant.

Read-only workflows require effective `create_read_only_runs`. Read-write and
approval-gated workflows require effective `create_read_write_runs` across all
three permission layers. AcornOps still enforces every approval gate before a
write can execute.

Create a workflow session before launching a run:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/workflows/{workflowId}/sessions
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
Content-Type: application/json
```

```json
{
  "workspaceId": "workspace-id",
  "approvedContextGrants": ["workspace_metadata", "target_inventory"]
}
```

`approvedContextGrants` must exactly match the workflow context required for
the run: use `capabilityPolicy.contextGrants` from the selected workflow
definition. Missing grants return `WORKFLOW_CONTEXT_GRANT_DENIED`.
Unknown extra grants return `WORKFLOW_CONTEXT_GRANT_UNKNOWN`.

Persist the returned `session.id` as the adapter's external-thread mapping.
Only the exact integration link and client that created the Workflow session
may post external replies to it. The session pins the Workflow definition
version. Each message recompiles execution access from that pinned definition
and the caller's current effective permissions, and the current Workflow must
remain active.

Post the launch message to create the run:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/workflow-sessions/{sessionId}/messages
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
Content-Type: application/json
```

```json
{
  "content": "Triage @target[Production Cluster]. Start by showing the compiled read scope.",
  "clientRequestId": "mattermost-post-id"
}
```

Workflow V2 resolves typed prompt references such as `@target[...]` when the
message is launched. The message body accepts only `content` and the optional
idempotency key `clientRequestId`; target IDs, target types, and arbitrary input
objects are not accepted.

Response:

```json
{
  "message_id": "workflow-message-id",
  "run_id": "run-id",
  "executionId": "workflow-execution-id",
  "status": "queued"
}
```

The resource hierarchy is:

```text
Workflow session
└── execution per external message
    └── step attempt / run
        └── pre-step or runtime tool approval
```

Use `executionId` with the aggregate execution APIs. You may continue using
`run_id` with the backward-compatible per-run APIs.

Get sanitized execution state:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workflow-executions/{executionId}
```

Any linked integration with effective `read_workspace_data` for the workspace
may inspect this DTO, including executions created in the browser or by another
integration. The response excludes input context, Workflow and Agent snapshots,
compiled scopes, occurrence keys, continuation state, prompts, internal claims,
and integration provenance identifiers.

Prefer the aggregate replayable SSE stream for multi-step discovery:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workflow-executions/{executionId}/stream
Accept: text/event-stream
Last-Event-ID: {lastExecutionEventId}
```

The stream uses `event: workflow_execution` and durable monotonic event IDs.
You may also resume with `?after={lastExecutionEventId}`. It includes execution
status changes, step/run creation, accepted public run events, approval
references, safe output metadata, and terminal execution events. This avoids
having to guess or poll each next-step run ID.

Approval listings are workspace-readable, but external callers receive only
bounded control metadata such as the approval ID, safe summary, tool name,
status, decision, and expiry. Executable arguments, tool references and
results, actor IDs, and continuation state are never returned. To decide a pre-step Workflow
approval or a runtime `tool_write` approval, require an explicit confirmation
from the linked user and call:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/runs/{runId}/approvals/{approvalId}/decision
Content-Type: application/json

{"decision":"approved"}
```

Only the exact integration link and client recorded on the execution may
decide. Approval requires current effective `create_read_write_runs`. If write
permission was removed, the exact origin may still reject while it retains
workspace read access. Same-decision retries are idempotent; a conflicting
decision returns `409`; expired approvals cannot be revived. Browser-created,
other-link/client, delegated specialist, scheduled, and system-triggered approvals
fail closed.

Report metadata and downloads are also exact-origin:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/report-artifacts/{reportId}
GET {ACORNOPS_API_BASE_URL}/api/v1/report-artifacts/{reportId}/download
```

The metadata response omits report source and provenance.

### Example Adapter Command Mapping

AcornOps does not parse chat commands. The external bot adapter owns command
parsing, list numbering, selected workspace, selected target, current session,
latest run, and any per-chat state.

The examples below are non-normative. They show how an adapter could map a
simple chat command set onto the AcornOps endpoints in this document:

- `status`: call the account link resolve endpoint and report whether the
  external user is linked.
- `workspaces`: call workspace discovery endpoints.
- `workspace` and `workspace N`: show or select a workspace from adapter state.
- `targets`: list generic Kubernetes and VM targets in the current workspace.
- `target` and `target N`: show or select the current generic target.
- `clusters`, `cluster N`, `vms`, and `vm N`: optional shortcuts that can keep
  using the Kubernetes- and VM-specific endpoints.
- `resources`, `issues`, `sessions`, `session`, and `messages`: use the
  selected target or session and the endpoints below.
- `ask <question>`: create or reuse a read-only session, post a message, follow
  the returned run, and render the final assistant reply.
- `watch`: follow the latest run known to the adapter for the chat context.
- `run <runId>`: fetch run state, run events, and related session messages.

List endpoints are cursor-paged. An adapter that wants to avoid user-facing
pagination can auto-page internally with an implementation-defined cap and
render one combined response. The API does not provide an unbounded `all`
response.

### Target Discovery

List generic targets in a workspace:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets?limit=50&cursor={cursor}&q={search}&targetType=kubernetes
```

Get one target summary:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{targetId}
```

Representative target:

```json
{
  "id": "target-id",
  "workspaceId": "workspace-id",
  "targetType": "virtual_machine",
  "name": "payments-vm-01",
  "status": "online",
  "metadata": {},
  "createdAt": "2026-06-01T00:00:00.000Z",
  "updatedAt": "2026-06-01T00:00:00.000Z"
}
```

The `targetType` filter is optional and currently accepts `kubernetes` or
`virtual_machine`. Invalid values return `400 VALIDATION_ERROR` instead of
widening the query.

### Workspace Issues

List durable operational issues across a workspace:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/issues?limit=50&cursor={cursor}&q={search}&status=active&severity=critical&targetId={targetId}&namespace=default
```

Useful query parameters:

- `limit`: 1 to 100, default 50.
- `cursor`: pagination cursor from `nextCursor`.
- `q`: text search.
- `status`: `active`, `recovering`, `resolved`, or `all`.
- `severity`: `critical`, `warning`, or `info`.
- `targetId`: restrict to one target.
- `targetType`: `kubernetes` or `virtual_machine`.
- `namespace`: restrict to one Kubernetes namespace.

Representative item:

```json
{
  "id": "issue-id",
  "targetId": "target-id",
  "targetType": "kubernetes",
  "status": "active",
  "severity": "critical",
  "title": "Pod unhealthy",
  "summary": "Pod is unhealthy.",
  "namespace": "payments",
  "objectKind": "Pod",
  "objectName": "payments-api-abc123",
  "lastSeenAt": "2026-06-01T00:00:00.000Z"
}
```

### Kubernetes Clusters

List clusters in a workspace:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/kubernetes-clusters?limit=50&cursor={cursor}&q={search}&status=online
```

Get one cluster overview:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}
```

Representative cluster:

```json
{
  "id": "cluster-id",
  "workspaceId": "workspace-id",
  "name": "payments-prod",
  "status": "online",
  "namespaceInclude": [],
  "namespaceExclude": [],
  "writeConfirmationPolicy": {
    "effectiveRequired": false,
    "overrideRequired": null,
    "source": "deployment_default"
  },
  "latestSnapshot": {
    "clusterId": "cluster-id",
    "workspaceId": "workspace-id",
    "timestamp": "2026-06-01T00:00:00.000Z"
  },
  "summary": {
    "resourceCount": 120,
    "findingCount": 3,
    "criticalFindingCount": 1,
    "namespaceCount": 8,
    "nodeCount": 5,
    "resourceFamilyCounts": {
      "workloads": 60,
      "network": 20,
      "storage": 10,
      "cluster": 30
    },
    "resourceKindCounts": {
      "Pod": 42,
      "Deployment": 12,
      "Service": 14
    }
  }
}
```

List cluster resources:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/resources?limit=100&cursor={cursor}&q={search}&family=workloads&kind=Pod&namespace=default&health=attention
```

Useful filters:

- `family`: `workloads`, `network`, `storage`, or `cluster`.
- `kind`: resource kind, for example `Pod`, `Deployment`, `Node`.
- `namespace`: Kubernetes namespace.
- `health`: `healthy` or `attention`.

Representative resource:

```json
{
  "id": "resource-id",
  "family": "workloads",
  "kind": "Pod",
  "name": "payments-api-abc123",
  "namespace": "payments",
  "status": "Running",
  "clusterId": "cluster-id",
  "clusterName": "payments-prod",
  "item": {}
}
```

List target issues:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{targetId}/issues?limit=50&cursor={cursor}&q={search}&status=active&severity=warning&namespace=default
```

Useful filters:

- `status`: `active`, `recovering`, `resolved`, or `all`.
- `severity`: `critical`, `warning`, or `info`.
- `namespace`: Kubernetes namespace.
- `q`: text search.

Representative issue:

```json
{
  "id": "issue-id",
  "targetId": "cluster-id",
  "targetType": "kubernetes",
  "status": "active",
  "severity": "warning",
  "title": "Pod unhealthy",
  "summary": "Pod is unhealthy.",
  "namespace": "payments",
  "objectKind": "Pod",
  "objectName": "payments-api-abc123",
  "lastSeenAt": "2026-06-01T00:00:00.000Z"
}
```

### Virtual Machines

List VMs in a workspace:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/virtual-machines?limit=50&cursor={cursor}&q={search}&status=online
```

Get one VM overview:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}
```

Representative VM:

```json
{
  "id": "vm-id",
  "workspaceId": "workspace-id",
  "name": "payments-vm-01",
  "status": "online",
  "hostname": "payments-vm-01.internal",
  "osFamily": "linux",
  "serviceManager": "systemd",
  "allowedLogSources": ["journald"],
  "latestSnapshot": {
    "targetId": "vm-id",
    "workspaceId": "workspace-id",
    "timestamp": "2026-06-01T00:01:00.000Z"
  }
}
```

List VM resources:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/resources
```

Representative VM resource:

```json
{
  "targetId": "vm-id",
  "workspaceId": "workspace-id",
  "snapshotTs": "2026-06-01T00:01:00.000Z",
  "itemId": "service:sshd",
  "category": "service",
  "kind": "systemd_service",
  "scopeKind": null,
  "scopeName": null,
  "name": "sshd",
  "status": "running",
  "location": null,
  "needsAttention": false,
  "item": {}
}
```

VM issues use the target issue endpoint:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{vmId}/issues
```

### Assistant Sessions

The bot can create and use read-only troubleshooting sessions for Kubernetes
clusters and VMs when the linked user has `create_sessions` and
`create_read_only_runs`.

Create a Kubernetes cluster session:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
Content-Type: application/json
```

```json
{
  "title": "Investigate payments-api health"
}
```

Create a target-scoped session for a selected target:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
Content-Type: application/json
```

```json
{
  "title": "Investigate target health"
}
```

Session response:

```json
{
  "id": "session-id",
  "workspaceId": "workspace-id",
  "targetId": "target-id",
  "targetType": "kubernetes",
  "clusterId": "cluster-id",
  "createdBy": "acornops-user-id",
  "title": "Investigate payments-api health",
  "status": "open",
  "createdAt": "2026-06-01T00:00:00.000Z",
  "updatedAt": "2026-06-01T00:00:00.000Z",
  "lastMessageAt": "2026-06-01T00:00:00.000Z",
  "expiresAt": "2026-06-02T00:00:00.000Z"
}
```

For VM sessions, `targetType` is `virtual_machine` and `clusterId` is omitted.
For Kubernetes target-scoped sessions, `targetType` is `kubernetes` and
`clusterId` matches `targetId`.

List sessions for a Kubernetes cluster:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions?limit=20&cursor={cursor}&q={search}&status=open
```

List sessions for a target, including VMs:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions?limit=20&cursor={cursor}&q={search}&status=open
```

Get session metadata:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/sessions/{sessionId}
```

List messages:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/sessions/{sessionId}/messages?limit=100&cursor={cursor}
```

Representative message:

```json
{
  "id": "message-id",
  "sessionId": "session-id",
  "runId": "run-id",
  "role": "assistant",
  "kind": "assistant",
  "content": "The pod is restarting because...",
  "createdAt": "2026-06-01T00:02:00.000Z"
}
```

Post a user message and trigger a read-only assistant run:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/sessions/{sessionId}/messages
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
Content-Type: application/json
```

```json
{
  "content": "Check why payments-api is unhealthy. Do not make changes.",
  "toolAccessMode": "read_only",
  "clientMessageId": "external-message-id-123"
}
```

Response:

```json
{
  "message_id": "message-id",
  "run_id": "run-id"
}
```

Rules:

- Send `toolAccessMode: "read_only"` unless the integration client descriptor,
  workspace grant, and linked user's workspace role all allow
  `create_read_write_runs`.
- When `toolAccessMode: "read_write"` is accepted, write-capable tools still
  pause on configured approval gates. The same linked integration may decide
  approvals created by that individual troubleshooting run after explicit
  linked-user confirmation.
- Use `clientMessageId` for idempotency when retrying the same chat message.
- The linked AcornOps user must own the session. If another user created the
  session, AcornOps returns `403 CONVERSATION_OWNER_REQUIRED`.
- If any read-write permission layer is missing, AcornOps returns `403`.

### Run Observation

Get run state:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/runs/{runId}
```

Linked integrations receive a bounded public run view. The exact originating
link/client may receive the final assistant output needed by its adapter;
other linked integrations with workspace read access receive status and safe
metadata only. Prompts, compiled scopes, snapshots, resource bindings,
idempotency keys, raw tool results, reasoning, token deltas, and integration
provenance are never returned on this external surface.

Representative run:

```json
{
  "id": "run-id",
  "workspaceId": "workspace-id",
  "targetId": "target-id",
  "targetType": "kubernetes",
  "clusterId": "cluster-id",
  "sessionId": "session-id",
  "messageId": "message-id",
  "toolAccessMode": "read_only",
  "status": "running",
  "requestedAt": "2026-06-01T00:01:00.000Z"
}
```

Run statuses include `queued`, `dispatching`, `running`, `waiting_for_approval`,
`completed`, `failed`, and `cancelled`.

List run events:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/runs/{runId}/events
```

Stream run events with Server-Sent Events:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/runs/{runId}/stream
Accept: text/event-stream
```

External event lists and streams keep lifecycle and approval metadata but
strip prompt, reasoning, assistant-token, tool-argument, and tool-result
payloads. Use the aggregate Workflow execution stream for multi-attempt
Workflow discovery.

The SSE stream emits events as:

```text
event: run_started
data: {"run_id":"run-id","seq":1,"type":"run_started","payload":{}}
```

When a write-capable tool pauses for approval, the stream emits
`tool_approval_requested` with `payload.approval_id`, `payload.tool`,
`payload.summary`, and `payload.expires_at`. Raw tool arguments are deliberately
excluded from the external event surface. Adapters may
render that state and ask the linked external user to approve or reject in the
integration. The same linked integration may submit that explicit decision only
when it requested the individual troubleshooting run and still has effective
`create_read_write_runs`. Adapters may instead direct the user to the management
console. Later stream events use
`tool_approval_approved`, `tool_approval_rejected`, or
`tool_approval_expired`.

Use this console URL shape for the approval call-to-action:

```text
{MANAGEMENT_CONSOLE_BASE_URL}/workspaces/{workspaceId}/approvals?runId={runId}&approvalId={approvalId}
```

List write-tool approvals:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/runs/{runId}/approvals
```

Submit the linked external user's explicit decision:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/runs/{runId}/approvals/{approvalId}/decision
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
Content-Type: application/json

{"decision":"approved"}
```

The integration must have effective `create_read_write_runs`, and the run must
record the current external integration link and client as its request origin.
The control plane returns `403 EXTERNAL_INTEGRATION_APPROVAL_NOT_OWNED` for a
browser-created run or a run requested through another integration link. It
resolves Workflow, Agent, and troubleshooting run types before routing the
decision. The adapter must obtain an explicit linked-user confirmation and must
not auto-approve from the presence of a webhook or run event.

### Example Run-Following Flow

An adapter that wants a user command such as `ask <question>` to include the
final assistant reply can combine the session, message, run stream, and message
list endpoints:

1. Resolve the selected workspace and selected target from adapter state.
2. Create a target-scoped session when there is no current session for the chat
   context:

   ```http
   POST {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions
   ```

3. Post the question with the intended tool access:

   ```http
   POST {ACORNOPS_API_BASE_URL}/api/v1/sessions/{sessionId}/messages
   ```

   Use `toolAccessMode: "read_only"` by default. Use
   `toolAccessMode: "read_write"` only when the integration client descriptor,
   workspace grant, and linked user's workspace role all allow
   `create_read_write_runs`. Include a stable `clientMessageId`.

4. Use the returned `run_id` as the run to observe.
5. Prefer `GET /api/v1/runs/{runId}/stream` for live progress. Treat
   `run_completed`, `run_failed`, and `run_cancelled` as terminal signals.
6. If the stream emits `tool_approval_requested`, render the pending approval
   and require an explicit confirmation from the linked external user. Submit
   that decision through the run-scoped approval endpoint, or link the user to
   `{MANAGEMENT_CONSOLE_BASE_URL}/workspaces/{workspaceId}/approvals?runId={runId}&approvalId={approvalId}`.
7. If SSE is unavailable, poll `GET /api/v1/runs/{runId}` and optionally read
   `GET /api/v1/runs/{runId}/events` for progress.
8. Once the run is terminal, call
   `GET /api/v1/sessions/{sessionId}/messages` and render the newest assistant
   message for that run/session.

An adapter can use the same run-following sequence for a command such as
`watch`. A command such as `run <runId>` can call `GET /api/v1/runs/{runId}`,
`GET /api/v1/runs/{runId}/events`, and, when the run response includes
`sessionId`, `GET /api/v1/sessions/{sessionId}/messages`.

## Recent Target Chat Activity

The bot can read recent chat activity for a target:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity?windowSeconds=300
```

Response:

```json
{
  "targetId": "target-id",
  "targetType": "virtual_machine",
  "targetName": "payments-vm-01",
  "windowSeconds": 300,
  "generatedAt": "2026-06-01T00:05:00.000Z",
  "recentActivity": []
}
```

`windowSeconds` is clamped between 60 and 3600.

The bot can also stream future target chat activity events:

```http
GET {ACORNOPS_API_BASE_URL}/api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity/stream
Accept: text/event-stream
Authorization: Bearer {EXTERNAL_INTEGRATION_CLIENT_TOKEN}
x-acornops-external-user-id: {externalUserId}
```

The SSE stream emits `chat_activity` events. It supports `Last-Event-ID` and the
optional `after` query parameter for resume replay. Connections without a resume
cursor are live-only.

## Disallowed Endpoints

The bot must not call these endpoint families with external integration
credentials:

- `POST /api/v1/workspaces`
- workspace members, roles, invitations, audit log, AI settings, AI credentials
- target registration/update/delete endpoints
- agent-key rotation endpoints
- pod log and VM log endpoints
- MCP server, MCP tool, and target tool mutation endpoints
- workflow definition mutation, workflow schedules, workflow-scoped MCP,
  workflow run cancellation/resume, and paused/draft workflows
- `DELETE /api/v1/sessions/{sessionId}`
- `POST /api/v1/runs/{runId}/cancel`
- `POST /api/v1/runs/{runId}/approvals/{approvalId}/decision` for any
  browser-created, other-link/client, delegated specialist, scheduled, or
  system-triggered approval
- all `/admin/v1/*` endpoints
- all `/internal/v1/*` endpoints

These routes require browser sessions, admin tokens, or internal service tokens,
and AcornOps will reject the external integration credential.

## Example Integration Sequence

One possible integration sequence is:

1. Resolve link status for the external user.
2. If unlinked, create a link URL and ask the user to complete browser linking.
3. List workspaces and ask the user to choose when needed.
4. Use workspace, target, resource, and workspace-wide issue reads to gather
   context. Cluster- and VM-specific routes remain compatibility surfaces.
5. For assistant interactions, create a target session if one does not already
   exist for the conversation context.
6. Post messages with `toolAccessMode: "read_only"` and a stable
   `clientMessageId`.
7. Prefer `GET /api/v1/runs/{runId}/stream`, fall back to
   `GET /api/v1/runs/{runId}` and `GET /api/v1/runs/{runId}/events`, then fetch
   `GET /api/v1/sessions/{sessionId}/messages` for the final assistant reply.
8. Apply the deployment logging policy. Do not log client tokens, link URLs,
   link tokens, run stream payloads that may contain sensitive operational data,
   or user prompts unless that policy explicitly permits it.
