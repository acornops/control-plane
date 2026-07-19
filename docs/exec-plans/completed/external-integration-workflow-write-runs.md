# External integration Workflow write runs

Status: completed

## Goal

Allow linked external integrations to launch active read-write and
approval-gated Workflows, follow aggregate multi-step execution state, decide
only exact-origin approvals, retrieve exact-origin reports, and reply in the
same pinned Workflow session.

## Repositories

- `control-plane`: producer contract, provenance, authorization, execution SSE,
  reports, tests, and internal documentation.
- `management-console`: grant-copy clarification.
- `acornops-deployment`: default-deny descriptor examples.
- `docs-website`: public adapter and automation guidance.

No execution-engine contract change is expected.

## Implementation

- Add session/execution provenance and pinned Workflow snapshots.
- Recompile access from the pinned definition and current permissions for every
  message while requiring the current Workflow to remain active.
- Permit exact-origin pre-step and runtime write approval decisions.
- Publish sanitized workspace-readable execution DTOs and durable replayable
  aggregate SSE.
- Keep report access and Workflow session continuation exact-origin.
- Preserve per-run endpoints and default read-only integration capabilities.

## Validation

- Control-plane migration, type, contract, OpenAPI, authorization, and
  database-backed Workflow tests.
- Management-console lint, tests, and contracts.
- Deployment contracts and platform contracts.
- Public documentation checks, validation, and links.

## Rollout

Add `create_read_write_runs` explicitly to selected integration client
descriptors and user-approved workspace grants. Keep deployment examples
read-only by default. Monitor low-cardinality Workflow dispatch, approval,
execution-stream, denial, stale-approval, and `needs_review` outcomes.
