# MCP Installation Invariant Hardening

## Goal

Make directly registered MCP servers and materialized platform defaults obey the
same endpoint, credential, mutation, and presentation invariants across Agents,
Kubernetes targets, and virtual-machine targets.

## Scope

- Keep the retired workspace registry/catalog storage dormant and unmount its
  Agent/target import and reimport routes; it is not an active provisioning path.
- Keep platform defaults credential-free until a workspace administrator enables
  and configures the resulting workspace-owned installation.
- Preserve the existing Agent and target connection flows for unauthenticated,
  bearer-token, custom-header, and OAuth servers.
- Preserve AcornOps-managed built-in servers while preventing public callers from
  mutating their definitions.

## Decisions

- `McpServer.server_url` is the sole endpoint authority for discovery, credential
  construction, and invocation. A tool row's copied URL is compatibility data,
  never a dispatch destination.
- Public MCP endpoints are immutable after installation. Replacing an endpoint is
  a new installation; system reconciliation remains the only built-in rotation
  path.
- Authentication updates are validated against the effective current-plus-patch
  state. Changing authentication type resets type-owned header defaults instead
  of inheriting stale values from the previous type.
- Built-in server definitions are AcornOps-owned. Workspace users may change only
  server and tool enablement.
- Platform-managed definitions cross a dedicated internal synchronization
  boundary. Generic MCP create/update/delete routes cannot create or redefine a
  built-in server.
- Any edit that invalidates an authenticated connection must lead the
  administrator directly into reconnection; unauthenticated trust edits must
  explicitly prompt a new connection test.
- Server pagination is part of the public catalog contract; the console must not
  silently truncate installations.

## Work

- [x] Add gateway regression tests and make server URLs authoritative at runtime
  and in persisted tool rows.
- [x] Reset custom-header prefixes safely on auth-type transitions and preserve
  semantic discovery egress errors.
- [x] Enforce target built-in immutability, endpoint immutability, server-qualified
  tool lookup, and effective authentication validation.
- [x] Align OpenAPI and frontend types with pagination and disconnected-agent
  disabled reasons.
- [x] Make the Management Console load every server page and present disconnected
  built-ins accurately.
- [x] Unmount public workspace catalog import/reimport operations so the only
  active origins are direct administrator registration and platform sync.
- [x] Add an authoritative built-in synchronization endpoint, move Agent and
  target reconciliation to it, and preserve administrator-disabled state.
- [x] Reconnect credentials after authentication or public-header changes and
  show an explicit trust-change confirmation before invalidating connections.
- [x] Run focused and repository validation, then record residual dormant catalog
  risks and rollout requirements.

## Completion Criteria

- No MCP invocation dispatches to `tool.mcp_server_url` after resolving a server.
- A credential cannot be attached to an endpoint other than the resolved server
  endpoint, including when legacy tool rows are stale.
- Bearer-to-custom-header transitions produce an empty custom prefix unless the
  caller explicitly provides another prefix.
- Public callers cannot rename, re-authenticate, redefine, remove, or delete a
  built-in target MCP server.
- Catalog import/reimport operations are absent from the public route and OpenAPI
  surfaces.
- Platform reconciliation cannot accidentally re-enable a disabled built-in
  server.
- The Management Console displays more than one page of MCP servers and preserves
  `agent_disconnected` as an effective-disabled reason.
- Focused tests, type checks, contract checks, and production builds pass in every
  changed repository.

## Cross-Repository Dependency

The gateway and control-plane changes are a pinned deployment pair. The new
control plane calls the dedicated built-in synchronization route, while the new
gateway rejects the former generic built-in mutation path. Merge the gateway
change first and the control-plane change second, but release them together in a
maintenance window after remote MCP is disabled and active runs are drained.
Management Console and documentation consumers follow after that pair is
healthy. Platform Admin Console requires no credential contract change because
workspace defaults intentionally carry only name, endpoint, and destination
applicability.

## Validation Log

- Gateway canonical validation passed: Ruff, contract and harness checks, 580
  unit tests, and 52 keyless provider/contract evaluations.
- The PostgreSQL migration was upgraded from `a10047518e6a` with a deliberately
  mismatched tool row. A credential-bearing mismatch failed transactionally and
  preserved the previous revision and rows. After synthetic connection cleanup,
  the backfill removed the mismatch, server URL updates cascaded to the tool, and
  a raw mismatched write was rejected by the composite foreign key.
- Control-plane type, style, migration-chain, authorization, membership,
  run-event durability, contract, OpenAPI, focused MCP controller/service, and
  production build checks passed. Sixteen database-backed Agent MCP boundary,
  conversation-preview, and synchronization tests also passed against an
  isolated PostgreSQL database.
- Management Console UI package, design-system, type, 1,030-test, membership,
  contract, harness, production build, bundle-budget, and route-smoke checks
  passed.
- Platform Admin Console secret-free workspace-default policy and React UI tests
  passed (46 tests); no Platform Admin Console source changes were required.

## Rollout Requirements

1. Stop new admission and schedulers, drain active runs, disable remote MCP, and
   back up the gateway database and secret namespace. Do not allow an old process
   to execute a cached stale tool while the invariant changes.
2. Before the backfill, inventory rows where `gateway_tools.mcp_server_url` differs
   from the owning `gateway_mcp_servers.server_url`. Treat any authenticated match
   as a potential credential exposure: clean up its connections, require new
   credentials or OAuth authorization, and notify the workspace owner through the
   normal incident channel. Use the gateway maintenance command so secret and
   OAuth cleanup runs; never delete only database rows.
3. Deploy the pinned gateway/control-plane matrix together. Its migration job
   applies `b20058629f4b` before new applications start and blocks if affected
   connections remain. Verify the mismatch query returns zero and startup
   built-in reconciliation succeeds.
4. Deploy the Management Console changes, run credential and built-in smoke
   tests, then re-enable remote MCP. Existing workspace
   registry/catalog source and artifact storage remain dormant for future
   Platform Admin Console work, while public Agent/target import and reimport
   routes remain unmounted.
