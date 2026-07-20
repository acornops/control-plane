# Automatic workflow coordination

## Goal

Replace public entry-Agent and Manager routing with an order-independent
`agentIds` selection. One selected specialist runs directly; multiple selected
specialists run through one persistent, system-owned workspace coordinator.

Restore Agent-owned capability inheritance and add workflow-only, control-plane
native tools for selected-chat evidence and PDF report artifacts.

## Scope

- Add canonical workflow Agent selection storage and migration normalization.
- Derive internal entry/delegation policy transactionally and recompute the
  coordinator policy after workflow mutations.
- Hide Managers and internal coordinator identifiers from public APIs, audit
  metadata, search, compiled scopes, and traces.
- Add selection-aware readiness, deterministic delegation, cancellation,
  bounded audit metadata, and routing telemetry.
- Replace the public OpenAPI contract and add targeted regression coverage.
- Add inherit/restrict resolution across readiness, scheduling, compilation,
  coordination, delegation, and pinned run snapshots.
- Add native-tool catalog and Agent assignment APIs, scope-isolated dispatch,
  bounded PDF persistence, and the starter v1-to-v2 upgrade.

## Verification

- Targeted workflow, coordinator, visibility, migration, execution, readiness,
  cancellation, audit, and metrics tests.
- `npm run validate`
- `npm run openapi:export`
- Workspace platform-contract and validation checks.

## Delivery

Shared branch: `feat/extensible-catalog-sources`.
Merge order: control-plane, then management-console. No docs-website change is
required for the prompt-first target selection revision.

## Prompt-first target selection decision

- Target-bound workflow runs select one exact resource through the control
  message with `@target[Target name]`; no per-run picker or hidden target state
  participates in authorization.
- Starter prompts use the platform prompt-reference syntax. The `target`
  provider resolves an exact runtime route behind the generic binding contract.
- This starter revision is still in flight, so it does not increment the
  template version or migrate already-materialized development workflows.
- Delivery continues on `feat/extensible-catalog-sources`, with control-plane
  merged before management-console. No docs-website change is required.

## Target workflow capability split

- `Target diagnostics` remains the least-privileged read-only starter and uses
  only `target.diagnostics.read` mappings.
- `Target remediation` is a separate read-write starter. It combines diagnostic
  reads with `target.remediation.write`, requires one exact `@target[...]`, and
  gates every write-capable target tool behind approval.
- Read and write built-in tools are reconciled into separate exact-target
  mappings. Read-only compilation always removes write references, even if a
  malformed mapping supplies one.
- The final starter revision is version 4. Freshly provisioned workspaces receive
  the two automatic specialists and their two active workflows; opt-in templates
  are installed explicitly, and existing materialized workflows are not migrated.

## Starter workflow usability decision

- Automatic templates are runnable definitions, not examples. Their initial
  status is `active`; opt-in templates remain `paused`, and manual duplicates
  remain `draft` until an operator activates them.
- Seed and idempotent install paths use the same initial-status helper so
  workspace provisioning and later template installation cannot diverge.
- The upgrade retains the existing seed metric and records a bounded
  `automation.template_upgraded.v4` audit event without target, prompt, or
  credential data.
