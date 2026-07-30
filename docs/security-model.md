# Control Plane Security Model

## Trust Boundaries

- Browser traffic uses session cookies backed by OIDC or local password authentication.
- Password self-service signup requires AcornOps email verification unless an operator explicitly enables unverified signup for a private deployment.
- Password reset tokens prove mailbox possession; a successful reset verifies a pending password-backed account email and revokes existing browser sessions.
- Internal execution callbacks use `ORCH_SERVICE_TOKEN`.
- External integration account links use bearer tokens for installed integration clients configured in `EXTERNAL_INTEGRATION_CLIENTS_JSON`. AcornOps derives the integration client from the bearer token hash and scopes external identities by `(integration_client_id, provider, external_user_id)`; request bodies never choose the client or provider. Only an authenticated browser session may complete and bind an external identity to an AcornOps user. External integration client bearer tokens are accepted only by the account-link lifecycle, linked-user bot, and external webhook route connect/status endpoints.
- Linked external integration requests may also read permitted workspace and target operational summaries, create troubleshooting sessions, and post assistant messages by sending a registered external integration client token with `x-acornops-external-user-id`; this creates an `external_integration` auth credential, not a browser session. Runs are read-only by default. Read-write runs require explicit client, workspace-grant, and workspace-role opt-in.
- A linked integration with effective `create_read_write_runs` may launch active read-write or approval-gated Workflows and decide a write approval only when the individual troubleshooting run or Workflow execution records that exact active external integration link and client as its request origin. Workflow session continuation and report access use the same exact-origin rule; execution metadata and redacted aggregate execution events remain workspace-readable. The exact origin may reject a pending approval with current workspace read access after write permission is removed. External credentials fail closed for browser-created executions, another link/client, delegated specialist children, schedules, and system triggers. Adapters must obtain an explicit confirmation from the linked external user before submitting a decision; the client bearer credential is trusted to preserve that user interaction.
- Production platform-admin operations use `/admin/v1` and require two
  independent credentials: the console BFF's scoped bearer token and the
  human administrator's opaque OIDC-backed session. The effective permission is
  the intersection of both. Run-scoped JWTs, unrelated service tokens, normal
  browser sessions, and target agent keys are never accepted.
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
- Accept individual MCP credentials only on the current user's installation-scoped
  connection route and workspace-managed credentials only from authorized
  administrators. Forward them once to the gateway and never place them in
  logs, response bodies, or audit metadata. Clients cannot select the outbound
  authentication header; the MCP installation owns that configuration.
- Individual MCP OAuth uses authorization code with PKCE in the gateway and a
  control-plane browser binding cookie. In production the cookie is
  `__Host-acornops-mcp-oauth-binding` with Secure, HttpOnly, SameSite=Lax, and
  Path=/ attributes. Preparation and start require the same authenticated user,
  destination authorization, installation owner, and browser binding.
- The public CIMD document and callback URLs are derived only from
  `CONTROL_PLANE_BASE_URL` and `MANAGEMENT_CONSOLE_BASE_URL`; request Host
  headers are never trusted. Callback redirects are constrained to the
  canonical console origin and an encrypted-flow local path.
- Provider tokens, codes, state, PKCE material, authorization URLs, and raw
  provider errors are excluded from browser storage, audit metadata, logs, and
  connection status. The callback forwards only bounded protocol parameters to
  the gateway and returns a stable result code to the browser.
- Agents are invoked only through Workflows. Public standalone Agent runs and Agent-level inbound webhook triggers are not supported.
- Never log Agent or Workflow prompts, chat bodies, tool arguments, webhook payloads, report source, PDF contents, credentials, or continuation state. Audit stable IDs, actors, capability snapshots, decisions, and terminal outcomes.

## High-Risk Changes

- Session middleware, OIDC callbacks/linking, external integration account link completion, password credential flows, JWKS shape, or token claims
- Password email verification and reset token generation, storage, delivery, resend, and consumption behavior
- Agent registration or key rotation behavior
- Admin auth, audit, break-glass membership, quota, run intervention, or
  agent-key rotation behavior
- Internal execution auth or llm-gateway admin auth
- Cross-workspace, cross-target, or cross-cluster data access logic
- Agent/Workflow version, executor role, parent run, target, context-grant,
  tool-operation, approval, or idempotency claims

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
- Agent conversation access defaults to the least-privileged intersection of
  the pinned Agent permission mode and the creator's effective workspace
  capabilities. Write-capable Agents receive `read_write` conversation access
  only when the creator has `create_read_write_runs`; read-only Agent policy is
  a hard ceiling. Per-tool approval policy and run-scoped authorization remain
  authoritative after conversation creation.
- Agent session policy is a mandatory defense-in-depth allowlist. It may not
  elevate the local AgentK write or namespace policy.
- AgentK `restart_workload`, `scale_workload`, `patch_workload`,
  `patch_resource`, and `patch_configmap` remain run-authorized writes. AgentK
  advertises the full registered catalog, but discovery does not grant
  execution authority. The control plane forwards semantic arguments and
  narrows run access, but cannot expand AgentK's local write, patch-kind,
  non-secret configuration, namespace, or Kubernetes RBAC ceilings. Literal
  environment and ConfigMap writes require the caller's explicit
  non-secret-data assertion; the control plane does not infer or add that
  assertion.
- AgentK redacts ConfigMap `data` and `binaryData` values before complete-result
  artifact handling; guarded patch evidence exposes only bounded key metadata
  and `data` value fingerprints.
- Every automation callback and tool call must bind the workspace, Agent
  version, Workflow execution, step attempt, target, exact tool operation,
  approved context grants, and approval state from signed server claims.

## Automatic Investigations

- Target auto-triage is experimental and disabled by default. Only
  `manage_targets` may change its configuration or queue an eligible issue
  manually; modes that can request writes also require
  `create_read_write_runs`.
- Auto-triage does not use `manage_workflows`, Workflow definitions, Automation
  runtime mode, Workflow service identities, or the automation dispatch outbox.
- The target agent and saved target confirmation policy are ceilings.
  Automatic investigations may remove write tools or require more approvals,
  but they cannot add unsupported writes or bypass target-level confirmation.
  The effective policy is pinned when the run starts.
- Built-in target tools are registered as code-reviewed capabilities. Their
  bounded write tools are classified as auto-allowable, non-destructive writes,
  but that catalog metadata is not sufficient to bypass approval: the
  run-scoped gateway token must also carry `auto_allowed_changes`. Read-only and
  approval-required runs therefore retain their existing enforcement, while a
  full-write automatic investigation can execute only when the saved target
  confirmation policy permits it. External MCP tools retain their independently
  administered review, risk, and auto-allow metadata.
- System-started work uses the stable `system-auto-triage` service identity.
  It never borrows an individual user's MCP credentials. Tools that require
  those credentials are omitted and readiness reports a bounded degraded
  reason.
- Kickoff prompts contain bounded issue evidence plus delimited target
  instructions. Full instructions, raw evidence, credentials, and internal
  errors must not enter audit records, metrics, or public job errors. Secret
  patterns are redacted before prompt construction and terminal run error text
  is not duplicated into the auto-triage job record.
- One durable job is allowed per issue lifecycle. Leased claims, stable run
  IDs, dispatch idempotency, expected-status run locks, and lease-fenced atomic
  run/job transitions prevent retries or replica failover from creating a
  second automatic session or allowing an expired worker to overwrite recovered
  or terminal run state.
- Automatic session creation locks and verifies the enabled settings revision.
  Disablement or a policy edit cannot race a stale readiness check into starting
  a new chat with an outdated action policy.
- Browser members may participate in automatic sessions only with
  `create_sessions` and the capability required by their reply. The pinned
  automatic policy and target ceiling still apply. Manual sessions and
  external integrations retain creator-only participation.

## Admin Audit

- Mutating `/admin/v1` requests require a non-empty `reason` field.
- Production accepts only `platform-admin`, `platform-admin-viewer`, and
  `platform-admin-auditor`. MFA is verified from configured `acr`/`amr` claims;
  write operations also require authentication within the recent-auth window.
- Unsafe platform-admin BFF requests require an exact-origin signed double-submit CSRF token; unrelated operational admin tokens remain bearer-only.
  Admin sessions are opaque Redis records in secure, host-only, HTTP-only
  cookies with independent absolute and idle expiration.
- Mutating admin requests write `admin_audit_events`. Workspace membership
  mutations atomically write a protected Admin Audit success record and a
  workspace-visible event in the same transaction as the membership change.
  The workspace event uses `actor.type=admin_token` with the generic token label
  `platform-admin`, while an opaque correlation id links it to the protected
  record without exposing the administrator credential identifier.
- Admin audit metadata is sanitized before persistence. Request payloads,
  prompts, message bodies, authorization headers, raw tokens, and raw agent keys
  must not be persisted.
- Protected admin audit records are append-only and include immutable OIDC
  issuer and subject, readable identity and role snapshots, a non-reversible
  session reference, the separate BFF token ID, authentication time, request
  ID, source-IP hash, user agent, target, reason, outcome, and timestamp.
- Successful audit writes emit a structured security event for centralized log
  collection. Mutations fail closed when their required audit write fails.
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
