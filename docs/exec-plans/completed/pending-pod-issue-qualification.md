# Pending Pod Issue Qualification

## Goal

Keep transient Kubernetes `Pending` state visible as a snapshot finding without
promoting it immediately into a durable Target Issue.

## Constraints

- Do not change generic workflow trigger or dispatch behavior.
- Do not correlate issues with assistant or workflow runs.
- Promote actionable scheduling failures immediately.
- Promote ordinary pending state only after a bounded persistence threshold.
- Preserve existing issue fingerprints and lifecycle behavior.

## Validation Plan

- Cover transient, sustained, missing-age, `FailedScheduling`, and
  `Unschedulable` cases.
- Run focused target-issue tests and the canonical control-plane validation.

## Completion Criteria

- A normal short rollout does not create a pending-pod Target Issue.
- Sustained or explicitly blocked scheduling still creates one durable issue.
- Unrelated target issue derivation and workflow trigger behavior remain
  unchanged.

## Outcome

- Pending pods remain visible as snapshot findings.
- Ordinary pending state becomes a durable Target Issue after two minutes,
  based on the pod creation timestamp.
- `FailedScheduling` and `Unschedulable` evidence creates a durable issue
  immediately while the referenced pod is still pending.
- Recent scheduling events for pods that are already running do not create
  durable issues.
- Missing or invalid pod age fails closed without creating an ordinary pending
  issue.
- Workflow triggers, assistant runs, and AcornOps Events naming were not
  changed.

## Validation

- Focused derivation and repository tests: 12 passed.
- Repository test suite against isolated PostgreSQL: 977 passed.
- Type checking, style, migrations, authorization, membership, run-event
  durability, contracts, harness, and production build passed. The harness and
  build were also rerun after the final qualification tightening.
- Cross-repository platform contract checks passed.
- The canonical validation stops at the pre-existing checked-in admin OpenAPI
  artifact because it is stale (3,142 checked-in lines versus 3,151 generated);
  this change does not alter API routes or schemas.
