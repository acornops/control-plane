# Control Plane Development

## Scope

This repository owns the authoritative backend for auth, workspaces, the target core, Kubernetes cluster APIs, VM APIs, sessions, run state, agent WebSocket routing, and execution dispatch. Kubernetes clusters and Linux/systemd VMs are active target types; keep target-neutral session, MCP, and run behavior capability-driven so future VM variants can extend the model without Kubernetes-specific coupling. Deployment wiring and external service provisioning belong in `acornops-deployment`.

## Prerequisites

- Node.js 22+
- npm
- Postgres and Redis for runtime checks
- Optional: Docker Compose for standalone local dependencies

## Local Development

Install dependencies:

```bash
npm install
```

Run the control plane in watch mode:

```bash
npm run dev
```

Run database migrations:

```bash
npm run db:migrate
```

For full-stack local development:

```bash
cd ../acornops-deployment
task local-up
```

## Configuration

Important local and production variables:

- `DATABASE_URL`
- `REDIS_URL`
- `CONTROL_PLANE_BASE_URL`
- `MANAGEMENT_CONSOLE_BASE_URL`
- `CORS_ORIGIN`
- `OIDC_*`
- `ORCH_SERVICE_TOKEN`
- `EXTERNAL_INTEGRATION_CLIENTS_JSON`
- `EXTERNAL_INTEGRATION_LINK_TOKEN_TTL_SECONDS`
- `EXTERNAL_INTEGRATION_LINK_TTL_SECONDS`
- `EXTERNAL_INTEGRATION_LINK_TOKEN_RETENTION_DAYS`
- `TARGET_METRIC_HISTORY_RETENTION_DAYS`
- `EXECUTION_ENGINE_BASE_URL`
- `EXECUTION_ENGINE_DISPATCH_TOKEN`
- `LLM_GATEWAY_URL`
- `LLM_GATEWAY_ADMIN_TOKEN`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`
- `WEBHOOK_ALLOW_INSECURE_DEV_DELIVERY` for local-only webhook smoke tests that
  need HTTP delivery URLs such as `http://host.docker.internal:8077/...`. This
  flag is ignored in production.
- `WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON` (default `[]`; exact hostnames or
  leading `*.example.com` wildcard patterns)

GitHub and GitLab skill imports are fetched in the management console. The
control plane only receives the resolved Markdown snapshot plus informational
source metadata, then validates and stores it. Custom GitHub Enterprise and
self-managed GitLab hosts work because the console selects the provider
explicitly instead of inferring it from the hostname. The developer browser
must be able to reach the Git host API, and that host must allow browser API
requests for the import flow. The console derives GitHub Enterprise API URLs as
`/api/v3` and GitLab API URLs as `/api/v4`; use the optional API base URL field
for path-prefixed or otherwise custom deployments.

## Validation

Canonical validation:

```bash
npm run validate
```

Focused checks:

```bash
npm run typecheck
npm run test
npm run migrations:check
npm run authz:check
npm run contracts:check
npm run harness:check
npm run build
```

## Documentation Drift Control

Treat documentation as part of feature acceptance. Update the nearest durable doc in the same change when work changes user-facing behavior, APIs, contracts, configuration, migrations, deployment behavior, operations, security, or reliability.

If docs are intentionally unchanged, record `Docs impact: none` and the reason in handoff evidence.

## Documentation Harness

Keep `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `docs/index.md`, this file, and `docs/OPERATIONS.md` in sync when changing repo behavior. `npm run harness:check` enforces the required structure.
