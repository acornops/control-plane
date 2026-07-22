<p align="center">
  <img width="220" src="https://raw.githubusercontent.com/acornops/docs-website/main/logo/light.svg" alt="AcornOps" />
</p>

<h1 align="center">AcornOps Control Plane</h1>

<p align="center">
  <a href="https://github.com/acornops/control-plane/actions/workflows/ci.yml"><img src="https://github.com/acornops/control-plane/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/acornops/control-plane"><img src="https://codecov.io/gh/acornops/control-plane/branch/main/graph/badge.svg" alt="Coverage" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22-green.svg" alt="Node 22" /></a>
  <a href="docs/contracts/README.md"><img src="https://img.shields.io/badge/contracts-checked-blue.svg" alt="Contracts checked" /></a>
</p>

<p align="center">
  Node.js + Express + TypeScript implementation of the AcornOps control plane, with production-like local runtime via Docker Compose.
</p>

## Status

This repository owns the control-plane service code, production image, API contracts, migrations, and service-level docs. Full-system deployment wiring belongs in `acornops-deployment`.

## Agent-Assisted Development

This repository supports human and agent-assisted development. Start coding
agents from this repository root for control-plane-only work, and from the
AcornOps workspace cloned from the [`acornops`](https://github.com/acornops/acornops)
repository for changes that touch multiple AcornOps repositories.

## Contracts

Cross-repo contract documentation lives in [`docs/contracts/README.md`](docs/contracts/README.md). Treat that directory as the source of truth for management-console, execution-engine, llm-gateway, and agentk integration boundaries.
Machine-readable contract data lives in [`docs/contracts/manifest.json`](docs/contracts/manifest.json).
Run `npm run contracts:check` to mechanically verify the documented control-plane contracts against the implementation.

Coverage is generated in CI with `c8`, uploaded as a workflow artifact, and published to Codecov when `CODECOV_TOKEN` is configured for the repository.

## Documentation

Primary docs:

- [`AGENTS.md`](AGENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`docs/index.md`](docs/index.md)
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Whole-system architecture: [`../docs/system-architecture.md`](../docs/system-architecture.md)

## What This Includes

1. Base compose (`docker-compose.yml`) for deploy/default runtime:
   - control-plane
   - control-plane Postgres and Redis
2. Local override (`docker-compose.override.yml`) adds local integration dependencies:
   - Dex (default lightweight local OIDC provider)
   - optional Keycloak + Keycloak Postgres profile (`oidc-keycloak`)
   - optional cross-repo integration profile (`integration`) for:
     - Execution engine
     - LLM gateway + gateway Postgres/Redis/init
     - Mock MCP

## Project Structure

- `src/routes`: endpoint registration + middleware wiring only
- `src/controllers`: request handlers and orchestration logic
- `src/services`: external/internal service clients
- `src/store`: repository and runtime state coordination
- `src/infra`: Postgres/Redis infrastructure wiring
- `migrations/control-plane`: pre-release Postgres schema baseline

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- For the optional `integration` profile only, the following repos must be present as sibling folders:
  - `../execution-engine`
  - `../llm-gateway`

## Compose Modes

1. Default/production-style stack only:
```bash
docker compose -f docker-compose.yml up -d
```

Production URL defaults in compose derive from `BASE_DOMAIN` (`acornops.dev` by default) and can be overridden with explicit URL env vars.

2. Local control-plane standalone (base + override automatically):
```bash
docker compose up -d --build
```

This local mode runs `npm run dev` (`tsx watch`) with bind mounts, so code changes in this repository hot reload immediately.
The `control-plane-init` service runs migrations before the app starts.

Optional Keycloak parity mode:
```bash
OIDC_PROVIDER_NAME=keycloak \
OIDC_ISSUER_URL=http://keycloak:8080/realms/acornops \
OIDC_PUBLIC_ISSUER_URL=http://localhost:8082/realms/acornops \
OIDC_AUTHORIZATION_ENDPOINT_OVERRIDE=http://localhost:8082/realms/acornops/protocol/openid-connect/auth \
OIDC_TOKEN_ENDPOINT_OVERRIDE= \
OIDC_USERINFO_ENDPOINT_OVERRIDE= \
OIDC_JWKS_URI_OVERRIDE= \
docker compose --profile oidc-keycloak up -d --build
```

Optional cross-repo integration profile:
```bash
docker compose --profile integration up -d --build
```
This profile requires sibling repositories `../execution-engine` and `../llm-gateway`.
When enabled, execution-engine and llm-gateway are started in reload/watch mode as well.
Default local run bootstrap is configured to `LLM_DEFAULT_PROVIDER=openai` and
`LLM_DEFAULT_MODEL=gpt-5.5` (override via env if needed).
Agentic tool-loop guardrails are configurable via env:
`ASSISTANT_CONTEXT_MAX_TOKENS` (default `120000`),
`ASSISTANT_BUDGET_CENTS` (default `25`), `ASSISTANT_LLM_TEMPERATURE` (default `0.2`),
`ASSISTANT_MAX_RUNTIME_MS` (default `600000`), `ASSISTANT_MAX_STEPS` (default `16`),
`ASSISTANT_MAX_TOOL_CALLS` (default `24`), `ASSISTANT_MAX_DUPLICATE_TOOL_CALLS` (default `2`),
and `ASSISTANT_TOOL_DEFAULT_TIMEOUT_MS` (default `10000`).
Target chat instructions come from the registered target-adapter contract;
workflow and standalone Agent instructions come from their pinned Agent version.

## Start Local Control Plane (Standalone)

```bash
docker compose up -d --build
```

Check status:

```bash
docker compose ps
```

Key endpoints after local startup:

- Control plane: `http://localhost:8081`
- Control plane Swagger UI: `http://localhost:8081/docs`
- Control plane OpenAPI JSON: `http://localhost:8081/openapi.json`
- Dex (default): `http://localhost:5556/dex`
- Keycloak (optional): `http://localhost:8082`

When `--profile integration` is enabled:

- Execution engine: `http://localhost:8080`
- Execution engine Swagger UI: `http://localhost:8080/docs`
- LLM gateway: `http://localhost:8001`
- LLM gateway Swagger UI: `http://localhost:8001/docs`
- Mock MCP: `http://localhost:8002`

API docs exposure is controlled by `ENABLE_API_DOCS` (enabled by default in
local override, disabled by default in base/production compose). Swagger UI
assets are pinned in the application dependencies and served by the control
plane itself, so the docs do not require internet or CDN access at runtime.

## Start Full AcornOps Stack

For full platform bring-up (management console + control-plane + execution-engine + llm-gateway + agentk + edge proxy), use the deployment repository:

```bash
cd ../acornops-deployment
task local-up
```

In that mode, keep env changes in `acornops-deployment/env/local/.env.local` or the matching deployment-track env file. This repository's `.env.example` is only for running the control plane by itself.

This full-stack flow uses the deployment repo `Taskfile.yml` and requires the `task` CLI to be installed.

For Keycloak parity in full-stack mode:

```bash
task local-up LOCAL_OIDC_PROFILE=oidc-keycloak
```

Do not run this repository's local compose stack and `acornops-deployment` local stack at the same time on the same host ports.

If dependencies change (for example `package.json`), rebuild once:

```bash
docker compose up -d --build
```

## Persistence And Environment Parity

The control plane uses durable state:

- Control-plane data: Postgres (`cp-postgres`) + Redis (`cp-redis`)
- Gateway data: Postgres (`gateway-postgres`) + Redis (`gateway-redis`)
- Persistent Docker volumes are attached for all stateful services.

This mirrors production topology expectations: identity provider, durable data stores, and separated service boundaries.
The control-plane schema is managed by versioned SQL migrations. Use `npm run db:status` to inspect migration state and `npm run db:migrate` to apply migrations when running outside Compose. Operational details live in [`docs/database-migrations.md`](docs/database-migrations.md).

Starter automation is workspace provisioning, not development data. Every new workspace atomically receives the two current automatic specialist Agents, their two active workflows, and a completed version-4 starter installation marker. Opt-in templates are installed explicitly. No startup backfill repairs pre-existing workspaces, and the marker remains after users delete visible starter definitions so deleted content is not recreated.

Development target seeding is enabled by default for local development:

- workspace: `4b930d98-add9-4924-ab26-3c16d96ec373` (`Development Workspace`)
- cluster: `5b006e4c-509c-458a-9f02-5aafbdc01ade` (`Development Cluster`)
- VM: `9254df42-4d9b-4e63-8bb6-93442e7d9a45` (`Development Linux VM`)
- owner user: `dev@acornops.local / devpass`

The local target fixture creates the owner, workspace, Kubernetes target and settings, Linux VM target, and optional AgentK/AgentV registrations when `SEED_AGENT_KEY` and `SEED_VM_AGENT_KEY` are configured. Its workspace receives the same universal starter automation as every other workspace; the fixture does not create additional Agents or workflows. It does not seed provider credentials, MCP integrations, invitations, or additional users. Normal OIDC or password users do not receive seeded workspace membership on signup or login.

Set `SEED_DEVELOPMENT_DATA=false` for an empty local boot. Production startup rejects `SEED_DEVELOPMENT_DATA=true` so development data cannot be enabled accidentally in a deployed environment.

Conversation and run-event defaults:

- `CONVERSATION_RETENTION_DAYS=30`
- `CONVERSATION_RETENTION_JOB_INTERVAL_SECONDS=3600`
- `TARGET_CHAT_REPORT_RETENTION_DAYS=30` (bounded 1–365 days)
- `RUN_EVENT_BUFFER_SIZE=200` (in-memory replay buffer when `PERSIST_RUN_EVENTS=false`)
- `PERSIST_RUN_EVENTS=false` in local development and `true` in production.

Control-plane HA defaults:

- `CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED=false` in local development and `true` in production.
- `CONTROL_PLANE_INSTANCE_ID` defaults to the host or pod name and must be unique per replica.
- `CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS=90` controls Redis ownership expiry for live agentk WebSocket connections.
- `CONTROL_PLANE_AGENT_SNAPSHOT_INTERVAL_SECONDS=60` controls the default telemetry snapshot cadence sent to AgentKs during handshake.

In multi-replica deployments, Redis records the pod that owns each agent WebSocket and carries cross-pod JSON-RPC routing, run event fanout, and renewed scheduler leases. If an owning pod restarts, the agent reconnects and later commands route through the new owner; active commands on the closing connection can fail or time out.

## Local OIDC Providers

Dex is the default provider for local testing:

- Issuer: `http://localhost:5556/dex`
- Test owner login: `dev@acornops.local / devpass`
- Test operator login: `operator@acornops.local / devpass`
- Persistence: `dex-data` Docker volume (`sqlite3` backend)

Keycloak is available for local parity validation:

- Start with the Keycloak override command shown above in `Compose Modes`.
- Realm import: `deploy/keycloak/realm-acornops.json`
- Admin console: `http://localhost:8082/admin`
- Admin credentials: `admin / admin`
- Test owner login in realm: `dev@acornops.local / devpass`
- Test operator login in realm: `operator@acornops.local / devpass`

Generic OIDC provider support:

- discovery-based endpoints are used by default (`/.well-known/openid-configuration`).
- token client auth mode is configurable via `OIDC_TOKEN_ENDPOINT_AUTH_METHOD` (`client_secret_basic`, `client_secret_post`, `none`).
- optional endpoint overrides are available for split-network deployments:
`OIDC_AUTHORIZATION_ENDPOINT_OVERRIDE`, `OIDC_TOKEN_ENDPOINT_OVERRIDE`, `OIDC_USERINFO_ENDPOINT_OVERRIDE`, `OIDC_JWKS_URI_OVERRIDE`.
- in containerized local setups, set `OIDC_ISSUER_URL` to a control-plane reachable internal address and set `OIDC_AUTHORIZATION_ENDPOINT_OVERRIDE` to a browser-reachable address when they differ.

Management console SSO integration:

- `GET /api/v1/auth/oidc/login?return_to=<management-console-url>` is supported.
- After callback, control-plane sets the session cookie and redirects browser back to `return_to` when allowed by origin policy.
- OIDC discovery, token exchange, userinfo, and JWKS fetches are bounded by `OIDC_HTTP_TIMEOUT_MS` (default `10000`).
- `CORS_ORIGIN` accepts a comma-separated list of exact origins; the same normalized allow-list is used for OIDC `return_to` validation.

## Password and SSO Account Auth

The control plane supports username/password auth alongside OIDC. Both auth modes use the same canonical `users` table and create the same cookie-backed control-plane session. Password-specific credentials are stored separately in `user_password_credentials`, keyed by `user_id`, so the user profile and workspace membership model stays shared across auth sources.
OIDC identities are stored separately in `user_federated_identities`, keyed by provider and subject. OIDC callback login resolves by that stable provider subject first, not by email alone.

Account auth endpoints:

- `GET /api/v1/auth/config` returns `{ oidcEnabled, oidcProviderName, passwordAuthEnabled, passwordSignupEnabled }` for runtime UI capability rendering.
- `GET /api/v1/auth/csrf` returns a signed CSRF token; browser clients send it back as `x-csrf-token` on mutating requests.
- `GET /api/v1/auth/methods` returns the current user's password/SSO methods and account-security capabilities without exposing OIDC subjects.
- `POST /api/v1/auth/password/login` with `{ "identifier": "username-or-email", "password": "..." }`
- `POST /api/v1/auth/password/signup` with `{ "email": "...", "username": "...", "displayName": "...", "password": "..." }`
- `POST /api/v1/auth/password/change` lets authenticated password-backed users change their local password after current-password verification; successful changes rotate the current browser session and revoke other browser sessions.
- `POST /api/v1/auth/oidc/link/start` lets authenticated password-backed users explicitly connect SSO after current-password verification.

Account auth configuration:

- `SESSION_MAX_AGE_SECONDS=604800` controls the absolute browser session lifetime.
- `SESSION_IDLE_TIMEOUT_SECONDS=86400` controls the sliding idle timeout; active sessions refresh this window until the absolute max age is reached.
- `PASSWORD_AUTH_ENABLED=true` enables password login endpoints.
- `PASSWORD_SIGNUP_ENABLED=true` enables self-service signup. Keep this `false` in production unless a reviewed private deployment intentionally allows open signup.
- `PASSWORD_AUTH_MAX_ATTEMPTS=10` controls failed login attempts per identifier/IP window.
- `PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS=50` caps failed attempts per identifier across IPs.
- `PASSWORD_AUTH_RATE_LIMIT_WINDOW_SECONDS=900` controls the Redis-backed failed login window.
- `CSRF_SECRET` signs browser CSRF tokens and must be a generated production secret.
- `TRUST_PROXY` configures Express trusted proxy handling; set it only for trusted ingress/proxy hops.
- `OIDC_ENABLED=true` enables OIDC routes and advertises SSO to the management console.
- `OIDC_ADMISSION_POLICY_JSON={}` configures fail-closed verified-email, exact-domain, and required-claim rules. An empty object admits every successfully authenticated OIDC identity.
- `OIDC_PRELINKED_IDENTITIES_JSON=[]` explicitly reconciles trusted bootstrap mappings containing `subject`, `email`, `displayName`, and `emailVerified`. Duplicate or conflicting mappings fail startup and are never inferred from email.
- `OIDC_END_SESSION_ENDPOINT_OVERRIDE` and `OIDC_POST_LOGOUT_REDIRECT_URI` configure browser-facing RP-initiated logout when discovery is not directly usable by browsers.

Implementation notes:

- Passwords are never stored in plaintext; hashes use scrypt with a per-password random salt.
- Usernames are normalized to lowercase and must be 3-32 characters of letters, numbers, `_`, `-`, or `.`.
- Local passwords must be 15-1024 characters and must not match common or account-derived values.
- Signup rejects an email or username that already exists.
- OIDC login with a new provider subject and the same email as any existing user returns `ACCOUNT_LINK_REQUIRED`; email alone never attaches a new OIDC identity to an account.
- Explicit prelinks are resolved using the configured provider namespace plus subject before serving requests. They are intended for controlled fixtures and operator-managed bootstrap accounts, not general account discovery.
- OIDC-created users cannot add a local password later.
- OIDC sessions retain their verified ID token only in Redis so logout can send an `id_token_hint` directly to the provider. Password and development sessions always log out locally.
- Signup does not create or attach a workspace. New users see no workspaces until they create one or are added to an existing workspace.
- Password-backed accounts can use the enumeration-safe email password-reset flow when SMTP delivery is configured.

## Integration Contracts

### Target MCP servers, skills, and built-in tools

The management console consumes distinct target-scoped surfaces for MCP servers,
skills, and built-in tools:

- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/catalog`
- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/tools`
- `PATCH /api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/{toolId}`
- `PATCH /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/tools/{toolName}`
- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers`
- `POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers`
- `POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/test-connection`
- `GET|PUT|DELETE /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/connection`
- `POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/connection/verify`

Remote MCP server management is target-scoped. Kubernetes clusters and VMs both
use the target MCP, Skills, and built-in Tools surfaces. The Tools tab contains only
AcornOps built-in tools such as `web_search`; MCP-discovered
tools stay in the MCP catalog and paged server tool APIs.

MCP catalog responses include:

- target-scoped `permissions.canEdit` for tool/server mutation controls
- `servers[]` with built-in and remote MCP servers
- nested `tools[]` with both `enabledConfigured` and `enabledEffective`
- server-level and tool-level counts (`total`, `enabledConfigured`, `enabledEffective`, write counts)
- MCP discovery diagnostics per server (`connectionStatus`, `lastDiscoveryAt`, `lastDiscoveryError`)

Built-in Tools responses include `permissions.canEdit`, `items[]`, and
`web_search.config.domainFilters.{allowedDomains,blockedDomains}`.

Mutation policy:

- roles with `manage_mcp` can update MCP server settings.
- roles with `manage_tools` can update MCP tool toggles and built-in tool settings.
- Remote MCP server creation accepts connection details plus optional non-secret public headers; tools are discovered from the server's `tools/list` endpoint and remain disabled until an admin reviews and enables them.
- Personal-auth MCP installations use one write-only PAT per current user and
  installation. The installation determines bearer or custom-header formatting;
  a failed authenticated discovery retains the PAT for retry or replacement.
- other roles are read-only unless custom role templates grant the relevant capability.

### execution-engine integration

Control plane endpoints consumed by execution engine:

- `POST /internal/v1/runs/{runId}/bootstrap`
- `GET /internal/v1/sessions/{sessionId}/context?run_id=...`
- `POST /internal/v1/runs/{runId}/events`
- `GET /internal/v1/runs/{runId}/event-cursor`
- `POST /internal/v1/runs/{runId}/commit`

### Conversation lifecycle APIs

- `GET /api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions`
- `POST /api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions`
- `GET /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions`
- `POST /api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions`
- `GET /api/v1/sessions/{sessionId}`
- `DELETE /api/v1/sessions/{sessionId}`
- `GET /api/v1/sessions/{sessionId}/messages`
- `POST /api/v1/sessions/{sessionId}/messages`
  - accepts optional `clientMessageId` for idempotent message submission
  - returns `UNSUPPORTED_TARGET_TYPE` if the session target is not yet executable

Control plane dispatch targets:

- `POST {EXECUTION_ENGINE_BASE_URL}/api/v1/runs`
- `POST {EXECUTION_ENGINE_BASE_URL}/api/v1/runs/{runId}/cancel`

Both dispatch calls send `Authorization: Bearer <EXECUTION_ENGINE_DISPATCH_TOKEN>`.

### llm-gateway integration

The control plane issues RS256 run-scoped JWTs and exposes JWKS:

- `GET /api/v1/auth/jwks.json`
- `GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64` or `GATEWAY_SIGNING_PRIVATE_KEY_PEM` must be supplied in production so every control-plane replica signs with the same key.
- `GATEWAY_VERIFICATION_JWKS_JSON` can publish retired public keys during rotation.

Gateway verification settings in compose:

- `AUTH_JWKS_URL=http://control-plane:8081/api/v1/auth/jwks.json`
- `AUTH_ISSUER=llm-gateway`
- `AUTH_AUDIENCE=execution-gateway`

### agentk integration

Agent websocket endpoint:

- `ws://localhost:8081/api/v1/agent/connect`

For `agentk`:

- `ACORNOPS_AGENT_PLATFORM_URL=ws://localhost:8081/api/v1/agent/connect`
- `ACORNOPS_CLUSTER_ID=<cluster id returned by cluster register API>`
- `ACORNOPS_AGENT_KEY=<key returned by cluster register API>`

## Stop And Cleanup

```bash
docker compose down
```

Remove volumes too:

```bash
docker compose down -v
```

## Style Checks

Run style checks:

```bash
npm run style:check
```

## Validation

Run the checks that match the change:

- `npm run typecheck`
- `npm run contracts:check`
- `npm run harness:check`
- `npm run validate`
- `docker compose --profile integration up -d --build` for cross-repo validation when auth, gateway, or execution paths change
