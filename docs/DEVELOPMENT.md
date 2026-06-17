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
- `EXTERNAL_INTEGRATION_SERVICE_TOKEN`
- `EXTERNAL_INTEGRATION_LINK_TOKEN_TTL_SECONDS`
- `EXTERNAL_INTEGRATION_LINK_TTL_SECONDS`
- `EXECUTION_ENGINE_BASE_URL`
- `EXECUTION_ENGINE_DISPATCH_TOKEN`
- `LLM_GATEWAY_URL`
- `LLM_GATEWAY_ADMIN_TOKEN`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`

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
