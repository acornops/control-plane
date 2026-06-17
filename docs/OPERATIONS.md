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
- `MATTERMOST_CHAT_SERVICE_TOKEN`
- `EXECUTION_ENGINE_DISPATCH_TOKEN`
- `LLM_GATEWAY_ADMIN_TOKEN`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`

For multi-pod deployments, set a unique `CONTROL_PLANE_INSTANCE_ID` per pod.
The platform Helm chart sets it from the Kubernetes pod name. Production also
enables `CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED=true` by default.
`MANAGEMENT_CONSOLE_BASE_URL` is used for user-facing Mattermost account link
URLs returned by the integration endpoint and must be the public HTTPS console
origin in production.

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

Pre-release deployments may rewrite the schema baseline directly; reset
disposable databases when a local volume has already applied an older baseline.

## Failure Modes

- Readiness fails on Postgres: verify `DATABASE_URL`, network reachability, credentials, and migration state.
- Readiness fails on Redis: verify `REDIS_URL` and Redis availability.
- Agent appears disconnected: verify the agent WebSocket reaches `/api/v1/agent/connect` on the same public platform host over HTTPS/WSS. In production, the control plane rejects agent upgrades unless TLS is terminated directly or the edge proxy forwards `X-Forwarded-Proto: https` or `wss`.
- Multi-replica inconsistency: verify all pods share the same `REDIS_URL` and have unique `CONTROL_PLANE_INSTANCE_ID` values.
- Scheduler lease renewal warnings: verify Redis latency/availability. The current task is allowed to finish, but another pod may take the next lease if renewal was lost.

## Required Validation

Before release or deployment chart changes:

```bash
npm run validate
```
