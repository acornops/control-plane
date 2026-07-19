# Control Plane Security Model

## Trust Boundaries

- Browser traffic uses session cookies backed by OIDC or local password authentication.
- Password self-service signup requires AcornOps email verification unless an operator explicitly enables unverified signup for a private deployment.
- Password reset tokens prove mailbox possession; a successful reset verifies a pending password-backed account email and revokes existing browser sessions.
- Internal execution callbacks use `ORCH_SERVICE_TOKEN`.
- External integration account links use bearer tokens for installed integration clients configured in `EXTERNAL_INTEGRATION_CLIENTS_JSON`. AcornOps derives the integration client from the bearer token hash and scopes external identities by `(integration_client_id, provider, external_user_id)`; request bodies never choose the client or provider. Only an authenticated browser session may complete and bind an external identity to an AcornOps user. External integration client bearer tokens are accepted only by the account-link lifecycle, linked-user bot, and external webhook route connect/status endpoints.
- Linked external integration requests may also read permitted workspace and target operational summaries, create troubleshooting sessions, and post assistant messages by sending a registered external integration client token with `x-acornops-external-user-id`; this creates an `external_integration` auth credential, not a browser session. Runs are read-only by default. Read-write runs require explicit client, workspace-grant, and workspace-role opt-in.
- A linked integration with effective `create_read_write_runs` may launch active read-write or approval-gated Workflows and decide a write approval only when the individual troubleshooting run or Workflow execution records that exact active external integration link and client as its request origin. Workflow session continuation and report access use the same exact-origin rule; execution metadata and redacted aggregate execution events remain workspace-readable. The exact origin may reject a pending approval with current workspace read access after write permission is removed. External credentials fail closed for browser-created executions, another link/client, standalone Agents, schedules, and system triggers. Adapters must obtain an explicit confirmation from the linked external user before submitting a decision; the client bearer credential is trusted to preserve that user interaction.
- Admin control-plane operations use `/admin/v1` with admin bearer tokens only.
  Browser session cookies, CSRF tokens, service tokens, run-scoped JWTs, and
  target agent keys are never accepted on admin endpoints.
- Builtin MCP bridge calls use the run-scoped gateway JWT issued during execution bootstrap.
- llm-gateway admin traffic uses the shared admin token value configured locally as `LLM_GATEWAY_ADMIN_TOKEN`.
- Run-scoped gateway JWTs are minted here, validated downstream, and re-validated by the builtin MCP bridge.
- agentk and AgentV websocket auth is keyed by target agent secrets, and production agent upgrades must arrive over HTTPS/WSS transport.

## Secrets

- Never log raw agent keys, bearer tokens, or OIDC secrets.
- Never log or return raw admin tokens. Production admin tokens must be
  configured as SHA-256 hash descriptors in `CONTROL_PLANE_ADMIN_TOKENS_JSON`.
- Never log password email verification or reset tokens, token hashes, SMTP credentials, or email bodies. Production verification and reset URLs are also suppressed unless an operator enables the explicit unsafe `EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION=true` log-delivery override.
- Keep JWKS issuer and audience settings aligned with downstream consumers.
- Treat run-scoped gateway JWTs as bearer secrets; builtin MCP bridge scope must come from JWT claims, not caller-supplied headers.
- Treat external integration `intlink_` link tokens as short-lived bearer secrets. Store them only as hashes, invalidate older pending tokens when a new token is issued for the same external user, never log them, and never return browser cookies or OIDC provider tokens to external integration clients.
- Treat raw external integration client tokens as operator secrets. Commit only descriptor examples with SHA-256 hashes, never raw client tokens, and never return raw client tokens in API responses or audit metadata.
- Treat MCP `publicHeaders` as visible non-secret metadata only; credential-like, hop-by-hop, and platform routing headers must be rejected before forwarding to the gateway.
- Treat Agent webhook HMAC secrets as one-time-disclosed credentials. Persist only encrypted secret material, validate the signed raw body and timestamp, and deduplicate durable event IDs before dispatch.
- Never log Agent or Workflow prompts, chat bodies, tool arguments, webhook payloads, report source, PDF contents, credentials, or continuation state. Audit stable IDs, actors, capability snapshots, decisions, and terminal outcomes.

## High-Risk Changes

- Session middleware, OIDC callbacks/linking, external integration account link completion, password credential flows, JWKS shape, or token claims
- Password email verification and reset token generation, storage, delivery, resend, and consumption behavior
- Agent registration or key rotation behavior
- Admin auth, audit, break-glass membership, quota, run intervention, or
  agent-key rotation behavior
- Internal execution auth or llm-gateway admin auth
- Cross-workspace, cross-target, or cross-cluster data access logic
- Agent/Workflow version, step, target, context-grant, tool-operation, approval, or idempotency claims

## Authorization

- Workspace roles and capabilities are defined in [authorization-matrix.md](/docs/authorization-matrix.md).
- Browser clients receive `currentUserRole` and `permissions` from `GET /api/v1/workspaces`, but server-side checks remain authoritative.
- Admin tokens use descriptor scopes such as `admin:workspace:read`,
  `admin:workspace:write`, `admin:member:write`, `admin:run:write`,
  `admin:agent-key:rotate`, and `admin:*`. These scopes are separate from
  workspace roles and never establish a browser user session.
- External integration credentials are default-deny except for user-approved
  per-workspace grants. Effective workspace permissions are the linked user's
  workspace role intersected with the registered client capability ceiling and
  the saved workspace grant. The default registered-client ceiling is
  `read_workspace_data`, `create_sessions`, and `create_read_only_runs`.
  Deployments may explicitly add `create_read_write_runs` to a client
  descriptor and the user's workspace grant when a linked integration may
  request write-capable troubleshooting runs and active Workflows. In that case
  write tools still use run-scoped authorization and configured write approval gates. Operational
  target data and permitted assistant conversations are visible; member, audit,
  logs, unrelated approval decisions, cancellation, deletion, settings, and
  management capabilities remain denied. Approval decisions are limited to
  exact-link/client troubleshooting runs and Workflow executions and retain
  external-integration audit attribution.
- Direct public agent tool calls are not exposed by the control plane; troubleshooting tool execution must use run-scoped gateway authorization.
- Agent session policy is a mandatory defense-in-depth allowlist. It may not
  elevate the local AgentK write or namespace policy.
- AgentK `patch_resource` remains a run-authorized write. The control plane
  forwards its semantic arguments but cannot expand AgentK's local patch-kind
  maximum or Kubernetes RBAC.
- Every automation callback and tool call must bind the workspace, Agent
  version, Workflow execution, step attempt, target, exact tool operation,
  approved context grants, and approval state from signed server claims.

## Admin Audit

- Mutating `/admin/v1` requests require a non-empty `reason` field.
- Mutating admin requests write `admin_audit_events`; workspace-scoped admin
  mutations also write workspace audit events with `actor.type=admin_token` and
  `actor.tokenId`.
- Admin audit metadata is sanitized before persistence. Request payloads,
  prompts, message bodies, authorization headers, raw tokens, and raw agent keys
  must not be persisted.
- All `/admin/v1` responses set `Cache-Control: no-store`.
- Agent-key rotation is the only admin operation that returns a secret, and the
  replacement key is returned once.

## Browser Headers

- API responses set a restrictive CSP, `X-Content-Type-Options: nosniff`, frame denial, no-referrer policy, and a deny-by-default permissions policy.
- The optional Swagger UI route uses a nonce-based, same-origin-only CSP and
  serves its pinned Swagger UI assets from the control-plane package when API
  docs are explicitly enabled. It has no runtime CDN dependency. CSP permits
  inline style attributes only on this optional documentation page because the
  pinned Swagger renderer generates them; inline scripts still require a nonce.
