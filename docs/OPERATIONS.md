# Control Plane Operations

## Runtime Contract

- `GET /health` is liveness only.
- `GET /ready` gates production traffic and checks Postgres plus Redis.
- API docs must stay disabled in production unless deliberately enabled for a
  private environment. When enabled, the pinned Swagger UI assets are served
  locally and require no CDN or internet access.
- Kubernetes control-plane replicas default to `3`; Redis coordinates agent WebSocket ownership, cross-pod JSON-RPC routing, run event fanout, and renewed scheduler leases.
- On SIGTERM/SIGINT, the agent gateway stops accepting upgrades, closes active agent WebSockets, rejects pending local commands, and releases ownership before Postgres/Redis clients close.

## Required Environment

- `NODE_ENV=production`
- `DATABASE_URL`
- `REDIS_URL`
- `CONTROL_PLANE_BASE_URL`
- `MANAGEMENT_CONSOLE_BASE_URL`
- `MCP_OAUTH_ENABLED` defaults to `true`; set it to `false` to disable automatic individual MCP OAuth.
- `CORS_ORIGIN`
- `OIDC_HTTP_TIMEOUT_MS` (default `10000`)
- `OIDC_CLIENT_SECRET`
- `OIDC_ENABLED` controls whether OIDC routes and the console sign-in option are available.
- `OIDC_ADMISSION_POLICY_JSON` defines fail-closed verified-email, email-domain, and required-claim admission rules. An empty object allows any successfully authenticated OIDC identity.
- `OIDC_END_SESSION_ENDPOINT_OVERRIDE` supplies a public browser-facing RP-initiated logout endpoint when discovery uses an internal hostname.
- `OIDC_POST_LOGOUT_REDIRECT_URI` must exactly match a post-logout redirect registered with the provider.

OIDC logout always deletes the current AcornOps browser session before redirecting to the provider. If the provider does not advertise or configure an end-session endpoint, logout completes locally and the console warns that the provider session may remain active. Deploying the versioned session format invalidates existing browser sessions.
- `ORCH_SERVICE_TOKEN`
- `EXTERNAL_INTEGRATION_CLIENTS_JSON`
- `EXTERNAL_INTEGRATION_LINK_TOKEN_RETENTION_DAYS` (default `30`)
- `TARGET_METRIC_HISTORY_RETENTION_DAYS` (default `30`)
- `EXECUTION_ENGINE_DISPATCH_TOKEN`
- `LLM_GATEWAY_ADMIN_TOKEN`
- `LLM_PROVIDER_OPENAI_API_SURFACE=responses|chat_completions` must match the
  llm-gateway deployment setting.
- `WEBHOOK_SECRET_ENCRYPTION_KEY`
- `WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON` (default `[]`)
- `WEBHOOK_WORKER_ENABLED` (default `true`)
- `WEBHOOK_WORKER_BATCH_SIZE` (default `50`)
- `WEBHOOK_WORKER_CONCURRENCY` (default `20`)
- `WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY` (default `4`)
- `WEBHOOK_MAX_ATTEMPTS` (default `10`)
- `WEBHOOK_MAX_RETRY_AGE_SECONDS` (default `86400`)
- `WEBHOOK_MAX_PAYLOAD_BYTES` (default `65536`)
- `WEBHOOK_MAX_SUBSCRIPTIONS_PER_WORKSPACE` (default `100`)

When the selected provider is OpenAI and the configured API surface is
`chat_completions`, control-plane preserves the target Web Search preference but
marks it unavailable and omits it from target assistant run grants. Restoring
`responses` makes the configured preference effective again. llm-gateway keeps
its native-tool validation as defense in depth.

## Automatic MCP OAuth

Automatic MCP OAuth is enabled by default. Before deploying, configure the
canonical public control-plane and console HTTPS URLs, Redis, and gateway
encrypted secret backend. The public console URL is the source of both
`/api/v1/mcp/oauth/client-metadata` and `/api/v1/mcp/oauth/callback`; its
same-origin `/api` route must forward both to the control plane without
rewriting the advertised origin. This keeps the callback on the host that owns
the browser's host-only AcornOps session cookie. Set `MCP_OAUTH_ENABLED=false`
on both backend components to disable it.

The callback requires the same AcornOps user session and the reusable
production `__Host-acornops-mcp-oauth-binding` cookie created during
preparation. The cookie is HttpOnly, Secure, SameSite=Lax, Path=/, and expires
after ten minutes. Authorization-server outages are not control-plane
readiness dependencies. Rollback is to disable the OAuth flag; existing none,
bearer-token, and custom-header connections remain available.

## Private Webhook Destinations

Outbound webhooks allow public HTTPS destinations by default and block private,
local, and reserved address ranges. `WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON`
adds operator-controlled exceptions for hostnames that resolve to RFC1918 IPv4,
RFC6598 shared, or IPv6 unique-local addresses:

```bash
WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON='["hooks.example.org","*.webhooks.example.org"]'
```

An exact hostname matches only itself. A leading `*.` pattern matches descendants
at any depth but not the apex; list the apex separately when required. The setting
does not restrict public webhook destinations. Invalid patterns fail startup.
IP-literal URLs and loopback, link-local, metadata, multicast, unspecified, and
reserved addresses remain blocked even for matching hostnames. Delivery resolves
every A/AAAA result, rejects the complete request if any result is unsafe, pins
the selected address, preserves the configured hostname for TLS verification,
and does not follow
redirects.

This application setting does not grant packet reachability. Kubernetes
deployments must also configure the platform chart's
`networkPolicies.webhooks.to` peers and ports, and private PKI deployments must
provide the control-plane additional CA bundle.

## Durable Webhook Delivery

Webhook events and per-subscription jobs are committed to Postgres before the
worker sends them. Every control-plane replica may claim jobs through expiring
leases; stale workers cannot commit delivery results after another replica has
reclaimed a lease. Retries preserve the event ID and payload, honor bounded
`Retry-After` values, and stop at the configured attempt or age limit.

`WEBHOOK_WORKER_CONCURRENCY` and
`WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY` are per-replica limits. Effective
cluster concurrency scales with the number of control-plane replicas. The
per-origin limit is capped by the lower global concurrency. The claim lease is
sized for the configured batch's worst-case same-origin drain at that effective limit,
so queued jobs do not become reclaimable merely because they are waiting for a
per-origin slot.

Set `WEBHOOK_WORKER_ENABLED=false` during maintenance to pause new claims while
event enqueueing continues. Re-enable the worker to drain the backlog. Issue
created/reopened notifications pause while an issue is recovering and are
superseded when a newer lifecycle version makes them stale. External endpoint
failures do not affect readiness.

## Additional CA Trust

Set both `ADDITIONAL_CA_BUNDLE_FILE` and `NODE_EXTRA_CA_CERTS` to the same
read-only PEM bundle when outbound TLS dependencies use an organization CA.
Node.js extends its public roots process-wide; the application validates that
the configured file is readable at startup. This does not enable TLS for
plaintext database, Redis, or internal-service URLs.

## Automation Runtime

Production defaults keep new automation dispatch disabled until the greenfield
baseline and current workspace provisioning are verified:

```bash
AUTOMATION_RUNTIME_MODE=off
AUTOMATION_CANARY_WORKSPACE_IDS=
AUTOMATION_WORKER_INTERVAL_MS=1000
ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS=900
```

Use `off`, then `shadow`, then `canary` with an explicit workspace allow-list,
and finally `on`. A run is acknowledged only after its Postgres run record and
dispatch-outbox entry commit. Postgres row claims are authoritative; Redis
leases reduce duplicate work but do not own scheduler correctness.

`GET /api/v1/workspaces/{workspaceId}/automation/diagnostics` reports the
workspace's runtime mode, outbox depth and age, Workflow run states grouped by
executor role and root/child graph position, trigger delivery state, scheduler
lag, pending approval age, template readiness reasons, and retained
report-source count. It requires workspace read access. Keep this dependency
view separate from `/ready`: a disconnected external MCP server makes affected
templates `needs_setup` or `blocked`, but it must not remove the control plane
from service.

The `/metrics` endpoint exposes low-cardinality `control_plane_automation_*`
counters and gauges for dispatch, triggers, approvals, terminal outcomes, PDF
rendering, MCP readiness failures, backlog age, scheduler lag, active runs, and
template readiness. Load the deployment rule group at
`observability/prometheus/alerts/control-plane-automation.rules.yaml`. Alert at
minimum when acknowledged dispatch is older than 30 seconds, scheduler lag is
over 60 seconds, an approval remains pending past 15 minutes, or any run enters
`needs_review`.

## Target Auto-Triage Worker

Target auto-triage is experimental, disabled by default, and activated only by
revisioned per-target Settings. Its leased worker runs inside every control-plane
process; it needs no chart value, environment variable, or separate deployment.
Postgres uniqueness on the issue lifecycle and stable session/run linkage make
claims and dispatch safe across retries and replica failover.
The explicit current-issue start action locks the settings revision and eligible
issues in one transaction. Linked run changes use both a valid job lease and an
expected run-status guard; terminal reconciliation repairs a job when the
execution engine wins a concurrent state transition.
Session creation holds a shared lock on the enabled settings revision, so
disablement or a policy edit that commits first prevents a stale worker from
starting a new chat.

The worker has its own one-second timer and error boundary. It does not use
`AUTOMATION_RUNTIME_MODE`, `AUTOMATION_WORKER_INTERVAL_MS`, Workflow schedulers,
or the automation dispatch outbox, so disabling or failing the Automation
runtime cannot pause target auto-triage. A process skips a tick while its prior
tick is still running; multiple replicas remain safe through durable job leases.

The worker admits at most two nonterminal automatic investigations per target.
Readiness blockers such as missing AI credentials, a disconnected target agent,
no usable diagnostic tools, or a configured MCP tool that cannot bootstrap
leave jobs blocked for exponential retries that begin at 30 seconds and cap at
15 minutes rather than discarding them. Repeated
checks for an unchanged readiness reason do not write another audit event.
Resolving an issue skips its unstarted job or stops the linked run through the
ordinary cancellation and approval-expiry paths.

Monitor the low-cardinality `control_plane_auto_triage_*` metrics for queued
trigger reasons, terminal outcomes, readiness/dispatch blockers,
queue-to-start latency, runtime dispatch events, active runs, current
nonterminal job states, and the oldest waiting-job age. The current-state gauges
make a growing or approval-stalled backlog visible without labeling workspace,
target, issue, session, or run IDs. Use the linked audit events and bounded
public error code for per-job investigation; prompt content, raw issue evidence,
credentials, and internal errors are intentionally absent.

For an initial production rollout, enable a small target cohort in Diagnose only
or Ask before changes mode first. Confirm that queue-to-start latency remains
within the expected collection interval, blocked counts correspond to known
readiness conditions, and no target accumulates more than two active automatic
runs. Review the target's effective write-confirmation setting before enabling
Apply allowed changes automatically. Expand the cohort only after automatic
sessions, approval links, issue-resolution cancellation, and audit actors have
been verified for both Kubernetes and virtual-machine targets.

Generated AgentK install commands use the latest chart release by default,
including experimental releases. Set `AGENTK_HELM_CHART_VERSION` when an
environment needs to pin an exact, tested chart version.
`AGENTK_HELM_VALUES_JSON` supplies platform-default downstream chart values,
such as an internal image mirror, as a JSON object. Generated identity,
connectivity, namespace-scope, and write-mode paths cannot be overridden.
`AGENTK_HELM_ADDITIONAL_CA_FILE_PATH` adds a `--set-file` argument for a public
PEM CA bundle; this path is resolved on the operator machine that executes the
generated command.

For multi-pod deployments, set a unique `CONTROL_PLANE_INSTANCE_ID` per pod.
The platform Helm chart sets it from the Kubernetes pod name. Production also
enables `CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED=true` by default.
`MANAGEMENT_CONSOLE_BASE_URL` is used for user-facing external integration account link
URLs returned by the integration endpoint and must be the public HTTPS console
origin in production.

Git skill imports are resolved by the control plane against
`GIT_IMPORT_HOSTS_JSON`. Each allowlisted entry declares `provider`
(`github` or `gitlab`), an HTTPS `webBaseUrl`, and its HTTPS `apiBaseUrl`.
The default contains GitHub.com and GitLab.com. Provider API access is
anonymous, so private repositories are not supported. Custom hosts require
control-plane network egress and, when applicable, additional CA trust. Users
paste only a full repository, folder, or `SKILL.md` URL; unsupported hosts fail
before any outbound request. Resolution has a 30-second overall deadline,
10-second per-request timeouts, bounded provider responses, and no redirect
following.

`EXTERNAL_INTEGRATION_CLIENTS_JSON` contains enabled integration client
descriptors, not raw tokens. Generate a raw bearer token for each installed
integration client out of band, store only its lowercase SHA-256 hash in the
descriptor, and deliver the raw token through the operator secret channel.
If `allowedCapabilities` is omitted, the client ceiling is
`read_workspace_data`, `create_sessions`, and `create_read_only_runs`. Add
`create_read_write_runs` only for a client that may request write-capable
troubleshooting runs or active Workflows, including approval-gated read-only
Workflows, and keep the three default capabilities when read-only runs must
continue to work. The linked user must separately approve the capability for
each workspace, and the user's workspace role remains the final ceiling. An
external integration can decide troubleshooting and Workflow write approvals
only for executions requested through the same active integration link and
client. Adapters must require an explicit linked-user confirmation before
calling the decision endpoint. Delegated specialist approvals inherit the
execution's origin boundary; browser-created, other-link/client, scheduled, and
system-triggered approvals remain denied.

## Admin API

The control-plane admin API is disabled unless explicitly enabled:

```bash
CONTROL_PLANE_ADMIN_API_ENABLED=true
CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED=true
PLATFORM_ADMIN_CONSOLE_BASE_URL=https://admin.acornops.dev
CONTROL_PLANE_ADMIN_TOKENS_JSON='[{"id":"platform-admin-console","name":"Platform admin console BFF","sha256":"<64 lowercase hex sha256>","scopes":["admin:self","admin:system:read","admin:workspace:read","admin:workspace:write","admin:user:read","admin:member:write","admin:audit:read"],"enabled":true}]'
PLATFORM_ADMIN_BFF_TOKEN_ID=platform-admin-console
ADMIN_OIDC_ISSUER_URL=https://keycloak.acornops.dev/realms/acornops
ADMIN_OIDC_CLIENT_ID=acornops-platform-admin
ADMIN_OIDC_REDIRECT_URI=https://admin.acornops.dev/admin-auth/oidc/callback
ADMIN_OIDC_ALLOWED_ROLES=platform-admin,platform-admin-viewer,platform-admin-auditor
```

`CONTROL_PLANE_ADMIN_TOKENS_JSON` contains descriptors, not raw tokens.
Production startup rejects enabled admin API configuration with no enabled token
descriptors, invalid hashes, unsupported scopes, duplicate ids, or placeholder
hash values. Generate raw tokens out of band, store only the SHA-256 hash in the
descriptor, and deliver the raw token through the operator secret channel.

Admin endpoints are mounted under `/admin/v1`. Production requests require the
console BFF token and the dedicated platform-admin session; the normal
management-console session is not accepted. `/admin-auth/oidc/login` starts the
authorization-code flow with PKCE, and the callback validates state, nonce,
signature, issuer, audience, exact role membership, and MFA assurance before
creating a one-hour session with a 15-minute idle timeout. Writes require
authentication no older than 15 minutes and signed CSRF evidence. Failed admin
auth attempts are rate-counted with Redis when available and recorded in
`control_plane_admin_auth_failures_total`. All responses are `no-store`.
Production startup rejects privileged session limits above those one-hour and
15-minute bounds. OIDC discovery, token endpoint, and JWKS dependency failures
return a stable retryable `503` with a request ID; detailed failure reasons stay
in the metric, structured security log, and protected Admin Audit rather than
being exposed to the browser.

All mutating admin requests require a `reason` field and write append-only admin audit
events. Workspace membership mutations commit the membership change, protected
Admin Audit success event, and sanitized workspace event atomically. Workspace
members see a generic `platform-admin` actor and opaque correlation id, not the
administrator credential id. Audit payloads are sanitized and must not include raw
tokens, message bodies, prompts, auth headers, or agent keys. Agent-key rotation
is the only admin response that returns a secret; the replacement key is returned
once. Login, failed login, logout, mutation requests, outcomes, and human
identity are retained in the protected admin audit stream and emitted as
structured security logs. Read-only admin requests remain in structured HTTP
access logs without creating protected audit records.

Supported admin scopes are:

```text
admin:*
admin:self
admin:system:read
admin:audit:read
admin:workspace:read
admin:workspace:write
admin:user:read
admin:user:write
admin:member:write
admin:target:read
admin:target:write
admin:agent-key:rotate
admin:tooling:write
admin:run:read
admin:run:write
```

## Quotas

The control plane enforces finite plan-backed quotas at write time. The default
plan can be replaced by deployment config:

```bash
WORKSPACE_PLANS_CONFIG_JSON='{"defaultPlanKey":"default","plans":[{"key":"default","name":"Default","quotas":{"members":100,"kubernetesClusters":30,"virtualMachines":30}}]}'
```

User workspace-membership quota is checked before creating membership rows,
including workspace creation and invitation acceptance. Workspace member quota
is checked before adding a new member to a workspace. Kubernetes cluster and
virtual machine quotas are checked before creating target rows. Quota failures return
`409 QUOTA_EXCEEDED` with `details.quotaKey`, `details.used`, and
`details.limit`; invitation acceptance quota failures leave the invitation
pending.

Admins with `admin:workspace:write` can change a workspace plan or set nullable
quota overrides through `/admin/v1/workspaces/{workspaceId}/plan` and
`/admin/v1/workspaces/{workspaceId}/quotas`. Plan changes that would put current
usage over the resulting effective limits are rejected before mutation.

## Password Email Verification And Reset

Select Password in the User Sign-In Methods platform setting to enable password
login and first-time self-service signup. Email verification is required by
default and needs usable email delivery. Password reset is enabled by default
for password-backed accounts and uses the same delivery channel:

```bash
PASSWORD_EMAIL_VERIFICATION_REQUIRED=true
PASSWORD_RESET_ENABLED=true
PASSWORD_RESET_TOKEN_TTL_SECONDS=3600
PASSWORD_RESET_REQUEST_WINDOW_SECONDS=300
EMAIL_DELIVERY_MODE=smtp
EMAIL_FROM="AcornOps <noreply@example.com>"
EMAIL_PUBLIC_BASE_URL=https://console.example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=...
SMTP_PASSWORD=...
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
```

`EMAIL_DELIVERY_MODE=log` is intended for local development and test
environments. In non-production, it logs verification and reset URLs so
developers can complete auth flows without an SMTP relay. Production startup
rejects password reset or password signup that requires verification while
email delivery is disabled. It also rejects log delivery unless
`EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION=true` is set as an explicit unsafe
override.

## Migration Operations

Run schema init before starting updated application code:

```bash
npm run db:migrate
```

Kubernetes deployments run this through the Helm migration Job:

```text
node dist/scripts/control-plane-db.js migrate
```

This version establishes a greenfield schema epoch. Tear down and recreate every
pre-release database before running the baseline; in-place upgrades are not
supported. Deploy the pinned control-plane, execution-engine, and gateway matrix
together.

## Failure Modes

- Readiness fails on Postgres: verify `DATABASE_URL`, network reachability, credentials, and migration state.
- Readiness fails on Redis: verify `REDIS_URL` and Redis availability.
- Agent appears disconnected: verify the agent WebSocket reaches `/api/v1/agent/connect` on the same public platform host over HTTPS/WSS. In production, the control plane rejects agent upgrades unless TLS is terminated directly or the edge proxy forwards `X-Forwarded-Proto: https` or `wss`.
- Multi-replica inconsistency: verify all pods share the same `REDIS_URL` and have unique `CONTROL_PLANE_INSTANCE_ID` values.
- Scheduler lease renewal warnings: verify Redis latency/availability. The current task is allowed to finish, but another pod may take the next lease if renewal was lost.
- Automation dispatch backlog: inspect the workspace automation diagnostics and `automation_dispatch_outbox`; do not delete acknowledged entries. Restore the execution engine or dependency and let workers reclaim them.
- Run in `needs_review`: an uncertain write or exhausted dispatch retry requires an authorized operator decision. Do not automatically replay the write.
- Approval older than 15 minutes: verify the approval-expiry worker is running on every control-plane replica and Postgres time is correct.

## Required Validation

Before release or deployment chart changes:

```bash
npm run validate
```
