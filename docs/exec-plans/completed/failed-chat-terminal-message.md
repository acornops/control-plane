# Failed Chat Terminal Message

## Goal

Ensure a target chat run that fails always has a durable assistant-side terminal message, including when the failure event reaches the control plane before the execution engine's terminal commit.

## Constraints

- Preserve terminal run status and reject reconciliation from a contradictory late commit.
- Keep terminal commit handling idempotent and retain existing run-event ordering.
- Limit backend changes to target chat runs; workflow and agent automation behavior is out of scope.
- Preserve structured run events, webhook transitions, and target chat activity signals.

## Acceptance Criteria

- A matching `failed` commit can fill missing usage, assistant metadata, and the assistant final message on an already-failed target run.
- A commit whose status differs from the existing terminal status cannot mutate the run or its assistant message.
- Repeated delivery after terminal details exist remains a no-op.
- Regression tests cover the reconciliation decision and controller behavior.

## Validation Log

- Red first: focused tests failed because failed terminal reconciliation did not exist.
- Passed: `node --import tsx --test test/internal-execution-events.test.ts`.
- Passed against an isolated PostgreSQL test database: `node --import tsx --test --test-concurrency=1 test/run-commit-controller.test.ts test/internal-execution-cancellation.test.ts`.
- Passed against an isolated PostgreSQL test database: `npm run validate`.
- After extracting the focused commit helper, passed again: `npm run typecheck`, `npm run style:check`, `npm run harness:check`, and the focused controller/cancellation tests above.

## Observability Impact

- Existing `run_failed` events and webhook transitions are unchanged.
- Successful reconciliation emits the existing `assistant_message.committed` target chat activity event.
- A structured info log records `runId`, `workspaceId`, and terminal status when reconciliation occurs.
- No new dependency, health check, or metric label is introduced.

## Completion Criteria

- Completed: targeted and full repository validation passed.
