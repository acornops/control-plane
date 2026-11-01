# Control Plane Development

## Scope

This repository owns the authoritative backend for auth, workspaces, the target core, Kubernetes cluster APIs, VM APIs, sessions, run state, agent WebSocket routing, and execution dispatch. Kubernetes clusters and Linux/systemd VMs are active target types; keep target-neutral session, MCP, and run behavior capability-driven so future VM variants can extend the model without Kubernetes-specific coupling. Deployment wiring and external service provisioning belong in `acornops-deployment`.

Windows/SCM support is implemented as a read-only, default-off preview. Keep it
disabled outside isolated qualification tests until the native release gates pass.

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
- `WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON` (default `[]`; exact hostnames or
  leading `*.example.com` wildcard patterns)

The control plane resolves Git skill URLs to bounded, pinned Markdown
snapshots. `GIT_IMPORT_HOSTS_JSON` is a deployment-owned array of
`provider`, `webBaseUrl`, and `apiBaseUrl` entries. It defaults to GitHub.com
and GitLab.com and may include GitHub Enterprise or self-managed GitLab hosts,
including path-prefixed web bases. Browser callers submit one repository,
folder, or `SKILL.md` URL; the server infers the provider, ref, and subpath.
Provider API requests are anonymous and reject redirects.

## Validation

Canonical validation:

```bash
npm run validate
```

Full regression coverage requires a disposable PostgreSQL database and a separate
Redis instance. Set the URLs below to those dependencies; database tests mutate
their fixtures and require a database name containing `test`. Do not point them
at a development or production database that holds data you need.

```bash
export NODE_ENV=test
export DATABASE_URL=postgresql://acornops:acornops@127.0.0.1:55432/acornops_control_plane_test
export CONTROL_PLANE_TEST_DATABASE_URL="$DATABASE_URL"
export CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL="$DATABASE_URL"
export REDIS_URL=redis://127.0.0.1:56379/0
npm run db:migrate
npm run validate
```

The ports and credentials above are examples for isolated test services. Without
the explicit test database URLs, database-backed cases can be skipped; a green
unit-only run does not establish persistence, ownership or migration coverage.

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

## Workspace execution capacity

See [Workspace Execution Capacity](workspace-execution-capacity.md) for runtime
invariants, rollout prerequisites and isolated replica verification.

Heartbeat freshness regression coverage lives in `test/agent-connection-freshness.test.ts`, `test/agent-heartbeat-gateway.test.ts`, `test/agent-heartbeat-recording.test.ts` and `test/agent-connection-reads.test.ts`. Run the real-store cases with the disposable test database configuration described above; the existing VM ownership regressions remain required.
