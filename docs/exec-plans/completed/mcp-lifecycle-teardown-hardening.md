# MCP Lifecycle Teardown and Membership-Generation Hardening

## Goal

Make Agent, target, workspace, and individual-user MCP lifecycle transitions
durable, retry-safe, and race-free across the control plane and llm-gateway.
Deletion must remove built-in and user-managed state without allowing sync,
OAuth, connection, readiness, or runtime operations to recreate or use a scope
after its lifecycle fence advances.

## Decisions

- Agent and target deletion use the service-token-only, idempotent gateway
  destination teardown API. Workspace deletion uses the corresponding workspace
  teardown API once, covering Agent-only and mixed-target workspaces. Remote
  teardown succeeds before the final local resource delete.
- Gateway tombstones remain the cross-process destination/workspace deletion
  authority. Ordinary public server deletion still rejects built-ins.
- A PostgreSQL trigger advances a safe positive `membership_generation` on every
  workspace-membership insert or delete. It is the mutation authority for every
  repository, invitation, administration, provisioning, and future SQL path.
- Individual MCP operations require the exact active, reconciled generation.
  The leased reconciler is removed-first, leases no more than one owner per
  workspace, uses lease-owner compare-and-set completion, and runs at concurrency
  two to match the gateway's dedicated lifecycle lock pool.
- The first pinned rollout intentionally resets existing individual MCP
  credentials and OAuth authorizations. Workspace-owned credentials remain
  unchanged. Only the migration backfill blocks global readiness; later
  operational failures remain principal-scoped and observable.
- User run tokens are signed locally while membership and lifecycle rows are
  share-locked in one short transaction. All target, Agent-chat, and Workflow
  bootstrap paths use this issuance boundary. Service identities remain
  generation-free.
- OAuth preparation and opaque state are correlated to the initiating
  workspace, user, server, return path, and generation. Callback admission
  validates and consumes the correlation in a short transaction before remote
  provider/gateway I/O. Composite membership foreign keys invalidate outstanding
  flows on committed removal.
- The retired best-effort secret cleanup queue is rejected unless empty and then
  dropped by migration `006`; there is no second workspace lifecycle worker or
  cleanup authority after the clean-break rollout.
- Direct MCP registration uses the same strict HTTPS endpoint and authentication
  header policy for Agents and targets. OAuth may omit `credentialMode`, which
  follows the documented `individual` default.

## Completed Work

- [x] Added typed destination/workspace lifecycle teardown clients, structured
  gateway error parsing, and mirrored lifecycle contracts.
- [x] Wired Agent, Kubernetes, virtual-machine, and workspace deletion to remote
  teardown before local deletion, including retry and Agent-only coverage.
- [x] Made periodic, handshake, and runtime built-in synchronization lifecycle
  fence aware while preserving public built-in immutability.
- [x] Added migration `006`, membership-generation triggers, OAuth correlation
  tables, cleanup retention, readiness index, and leased reconciliation.
- [x] Made foreground membership changes fail closed on reconciliation failure;
  kept brand-new workspace creation successful with a durable pending activation
  to avoid duplicate workspaces on retry.
- [x] Added exact-current-generation token issuance and Workflow-resume guards.
- [x] Tightened URL, authentication-header, response DTO, OpenAPI, and endpoint
  vector parity across Agent and target MCP routes.
- [x] Removed legacy cleanup scheduling and documented the pinned maintenance,
  one-time credential reset, acceptance queries, alert policy, and rollback
  boundary.

## Gateway Interface Assumptions

- `DELETE /api/v1/internal/mcp/destinations` accepts the discriminated Agent or
  target scope query and returns idempotent `204` after committing a durable
  terminal fence.
- `DELETE /api/v1/internal/mcp/workspaces/{workspace_id}` returns idempotent
  `204` and supersedes all destination and user lifecycle state for the workspace.
- `PUT /api/v1/internal/mcp/users/{user_id}/lifecycle` accepts
  `workspace_id`, `membership_generation` in `1..9007199254740991`, and
  `status=active|removed`. Newer and exact-idempotent transitions return `204`;
  stale/conflicting transitions return their structured `409` codes; cleanup
  failure returns retryable `503` while retaining the staged state.
- Gateway lifecycle-sensitive reads return `409 MCP_LIFECYCLE_FENCED`, and all
  individual operations require exact active generation. The control-plane and
  gateway manifest objects and endpoint vectors are byte/deep equal.

## Validation Log

- Typecheck, style, authorization, workspace-membership, run-event durability,
  contract, migration-static, OpenAPI, harness, and production build checks pass.
- Public OpenAPI coverage passes with 173 paths and 191 schemas; admin coverage
  passes with 33 paths and 32 schemas. Generated docs artifacts are current.
- A real PostgreSQL `001` through `006` upgrade check passed against a disposable
  database. It exercised generation insert/delete/re-add behavior, workspace
  cascade deletion, OAuth-correlation cascade, backfill-only readiness blocking,
  role-update stability, legacy-queue retirement, and the exact partial
  readiness index.
- The lifecycle-affected database-backed regression set passes 122/122 tests.
  This includes deletion ordering/retry, built-in and manual state, Agent-only
  workspaces, mixed targets, generation fencing, lease recovery/CAS, bigint
  mapping, OAuth correlation, current-principal token issuance, and readiness.
- The complete database-backed control-plane suite passes 1,205/1,209 tests.
  The four residual failures are unrelated existing environment/policy tests:
  one admin-MFA assertion and three password-email-verification delivery/config
  assertions. No MCP or lifecycle test fails.
- The mirrored MCP endpoint vector file is byte-identical to llm-gateway, and the
  full Control Plane/llm-gateway counterpart contract comparison passes.

## Rollout Requirements

Use the clean-break maintenance sequence in `docs/OPERATIONS.md`: drain the old
queue, scale every old control-plane and gateway replica to zero, back up both
databases and the gateway secret namespace, apply the pinned migrations, and
start only the pinned pair. Keep traffic out of readiness routing until the
migration-backfill blocker count is zero and all lifecycle failures have been
investigated. There is no application-only rollback across migration `006`;
before traffic, restore both databases and the secret namespace atomically, and
after any new credential write, forward-fix only.

## Completion Criteria

All public resource deletion paths use privileged idempotent teardown, terminal
fences stop recreation, membership generations cover every SQL mutation path,
individual OAuth/readiness/runtime/token operations fail closed on stale state,
focused lifecycle tests and repository gates pass, and the pinned rollout is
documented with observable acceptance criteria.
