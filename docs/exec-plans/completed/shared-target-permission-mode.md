# Shared Target Permission Mode

## Goal

Make `permissionMode` the canonical run-safety policy for Kubernetes targets and
Agents, backed by one restrictive policy resolver.

## Contract

- Kubernetes cluster responses add `permissionMode`, `permissionModeOverride`,
  and `permissionModeSource`.
- Cluster PATCH accepts `permissionModeOverride` with `read_only`,
  `ask_before_changes`, `auto_allowed_changes`, or `null` for the deployment
  default.
- Legacy `writeConfirmationRequiredOverride` and `writeConfirmationPolicy`
  remain accepted/returned as conservative compatibility projections.
- Existing `true` maps to `ask_before_changes`; `false` maps to
  `auto_allowed_changes`. Only the new enum can select `read_only`.

## Security invariants

- Effective policy is the most restrictive applicable mode.
- Read-only removes write tools; approval-required gates every permitted write;
  automatic writes require every applicable layer to allow them.
- Permission policy never creates target write capability or bypasses workspace
  authorization, tool review, or adapter RBAC.
- Cluster policy mutations continue to require `manage_targets` and remain
  audited.

## Outcome

- Agent chat and target runs use the same permission-mode resolver.
- Kubernetes persistence, PATCH, webhook, audit, OpenAPI, and runtime bootstrap
  paths use the enum contract.
- Legacy boolean fields remain conservative compatibility projections.
- Persistence uses forward migration `002`: existing booleans are backfilled,
  both columns remain synchronized during mixed-version rollout, and the
  original baseline checksum is preserved.
- Read-only cluster policy removes write tools even from requested read-write
  runs.

## Validation

- Focused policy, Agent chat, controller, repository, confirmation, and target
  tool-resolution tests passed.
- Typecheck, style, harness, migration static checks, authorization, membership,
  run-event durability, contracts, OpenAPI coverage, and build passed.
- Forward-migration validation covers legacy `true`/`false`/`NULL` backfill and
  synchronization for old and new writers.
- The complete `npm run validate` test phase requires
  `CONTROL_PLANE_TEST_DATABASE_URL`; database-backed suites were not available
  in this workspace.
