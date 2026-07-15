# Control Plane Operations

## Runtime Contract

- `GET /health` is liveness only.
- `GET /ready` gates production traffic and checks Postgres plus Redis.
- API docs must stay disabled in production unless deliberately enabled for a private environment.
- Kubernetes control-plane replicas default to `3`; Redis coordinates agent WebSocket ownership, cross-pod JSON-RPC routing, run event fanout, and renewed scheduler leases.
- On SIGTERM/SIGINT, the agent gateway stops accepting upgrades, closes active agent WebSockets, rejects pending local commands, and releases ownership before Postgres/Redis clients close.

## Required Environment

- `NODE_ENV=production`
- `DATABASE_URL`
- `REDIS_URL`
- `CONTROL_PLANE_BASE_URL`
- `MANAGEMENT_CONSOLE_BASE_URL`
- `CORS_ORIGIN`
- `OIDC_HTTP_TIMEOUT_MS` (default `10000`)
- `OIDC_CLIENT_SECRET`
- `ORCH_SERVICE_TOKEN`
- `EXTERNAL_INTEGRATION_CLIENTS_JSON`
- `EXTERNAL_INTEGRATION_LINK_TOKEN_RETENTION_DAYS` (default `30`)
- `TARGET_METRIC_HISTORY_RETENTION_DAYS` (default `30`)
- `EXECUTION_ENGINE_DISPATCH_TOKEN`
- `LLM_GATEWAY_ADMIN_TOKEN`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`

## Additional CA Trust

Set both `ADDITIONAL_CA_BUNDLE_FILE` and `NODE_EXTRA_CA_CERTS` to the same
read-only PEM bundle when outbound TLS dependencies use an organization CA.
Node.js extends its public roots process-wide; the application validates that
the configured file is readable at startup. This does not enable TLS for
plaintext database, Redis, or internal-service URLs.

## Automation Runtime

Production defaults keep new automation dispatch disabled until migrations and
template backfill are verified:

```bash
AUTOMATION_RUNTIME_MODE=off
AUTOMATION_CANARY_WORKSPACE_IDS=
AUTOMATION_WORKER_INTERVAL_MS=1000
AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS=900
```

Use `off`, then `shadow`, then `canary` with an explicit workspace allow-list,
and finally `on`. A run is acknowledged only after its Postgres run record and
dispatch-outbox entry commit. Postgres row claims are authoritative; Redis
leases reduce duplicate work but do not own scheduler correctness.

`GET /api/v1/workspaces/{workspaceId}/automation/diagnostics` reports the
workspace's runtime mode, outbox depth and age, active Agent and Workflow run
states, trigger delivery state, scheduler lag, pending approval age, template
readiness reasons, and retained report-source count. It requires workspace read
access. Keep this dependency view separate from `/ready`: a disconnected
external MCP server makes affected templates `needs_setup` or `blocked`, but it
must not remove the control plane from service.

The `/metrics` endpoint exposes low-cardinality `control_plane_automation_*`
counters and gauges for dispatch, triggers, approvals, terminal outcomes, PDF
rendering, MCP readiness failures, backlog age, scheduler lag, active runs, and
template readiness. Load the deployment rule group at
`observability/prometheus/alerts/control-plane-automation.rules.yaml`. Alert at
minimum when acknowledged dispatch is older than 30 seconds, scheduler lag is
over 60 seconds, an approval remains pending past 15 minutes, or any run enters
`needs_review`.

Generated AgentK install commands use the latest chart release by default,
including experimental releases. Set `AGENT_HELM_CHART_VERSION` when an
environment needs to pin an exact, tested chart version.
`AGENT_HELM_VALUES_JSON` supplies platform-default downstream chart values,
such as an internal image mirror, as a JSON object. Generated identity,
connectivity, namespace-scope, and write-mode paths cannot be overridden.
`AGENT_HELM_ADDITIONAL_CA_FILE_PATH` adds a `--set-file` argument for a public
PEM CA bundle; this path is resolved on the operator machine that executes the
generated command.

For multi-pod deployments, set a unique `CONTROL_PLANE_INSTANCE_ID` per pod.
The platform Helm chart sets it from the Kubernetes pod name. Production also
enables `CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED=true` by default.
`MANAGEMENT_CONSOLE_BASE_URL` is used for user-facing external integration account link
URLs returned by the integration endpoint and must be the public HTTPS console
origin in production.

GitHub and GitLab skill imports are fetched by the management console and
submitted to the control plane as resolved Markdown snapshots. The control plane
does not require Git provider egress or credentials for this flow. Custom
GitHub Enterprise and self-managed GitLab hosts work when users choose the
matching provider in the import dialog. User browsers must be able to reach the
Git host API, and the Git host must allow browser API requests from the console
origin. The console derives GitHub Enterprise API URLs as `/api/v3` and GitLab
API URLs as `/api/v4`; operators should tell users the API base URL for
path-prefixed or otherwise custom deployments.

`EXTERNAL_INTEGRATION_CLIENTS_JSON` contains enabled integration client
descriptors, not raw tokens. Generate a raw bearer token for each installed
integration client out of band, store only its lowercase SHA-256 hash in the
descriptor, and deliver the raw token through the operator secret channel.

## Admin API

The control-plane admin API is disabled unless explicitly enabled:

```bash
CONTROL_PLANE_ADMIN_API_ENABLED=true
CONTROL_PLANE_ADMIN_TOKENS_JSON='[{"id":"ops-primary","name":"Ops primary","sha256":"<64 lowercase hex sha256>","scopes":["admin:*"],"enabled":true}]'
```

`CONTROL_PLANE_ADMIN_TOKENS_JSON` contains descriptors, not raw tokens.
Production startup rejects enabled admin API configuration with no enabled token
descriptors, invalid hashes, unsupported scopes, duplicate ids, or placeholder
hash values. Generate raw tokens out of band, store only the SHA-256 hash in the
descriptor, and deliver the raw token through the operator secret channel.

Admin endpoints are mounted under `/admin/v1` and require
`Authorization: Bearer <admin-token>`. Browser sessions and internal service
tokens are intentionally rejected. Failed admin auth attempts are rate-counted
with Redis when available and recorded in `control_plane_admin_auth_failures_total`.
All admin responses set `Cache-Control: no-store`.

All mutating admin requests require a `reason` field and write admin audit
events. Workspace-scoped mutations also write workspace audit events with
`actor.type=admin_token`. Audit payloads are sanitized and must not include raw
tokens, message bodies, prompts, auth headers, or agent keys. Agent-key rotation
is the only admin response that returns a secret; the replacement key is returned
once.

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

Production password self-service signup remains disabled by default. If an
operator enables it, email verification is required by default and needs usable
email delivery. Password reset is enabled by default for password-backed
accounts and uses the same delivery channel:

```bash
PASSWORD_SIGNUP_ENABLED=true
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

Automation migrations are additive and forward-compatible. Runtime rollback is
performed by setting `AUTOMATION_RUNTIME_MODE=off` and restoring the previous
images; do not roll back the schema.

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
