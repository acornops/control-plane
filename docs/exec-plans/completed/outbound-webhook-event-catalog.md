# Outbound webhook event catalog review

## Goal

Keep the workspace-scoped outbound webhook catalog limited to deliverable,
externally useful events while preserving the separate workspace audit catalog.

## Evaluation

Each event was checked for a real producer, deliverability after subscription
creation, a distinct external use, stable public meaning, and bounded payload.
All catalog entries except `workspace.created.v1` have active producers and
support lifecycle notification, operational health, approvals, issue alerts,
configuration drift, or compliance use cases.

`workspace.created.v1` cannot reach a workspace-scoped subscription because the
workspace and its subscription container do not exist until after creation.
The event remains useful and unchanged in workspace audit history.

`workspace.deleted.v1` remains an outbound event because deletion snapshots
eligible subscriptions before removing the workspace, allowing a final
notification to be delivered after deletion.

## Compatibility

New create and update requests reject the retired outbound event. Subscription
reads filter the known retired value so stale persisted selections do not break
strict console response parsing. No database or deployment change is required.

## Validation

- The focused control-plane webhook contract suite passed all nine tests.
- The remaining 29 outbound events all have a production source reference.
- Control-plane type, style, contract, OpenAPI, harness, build, and greenfield
  migration static checks passed. Full validation reached the test phase but
  cannot complete without `CONTROL_PLANE_TEST_DATABASE_URL` and a running
  PostgreSQL test service.
- The focused management-console webhook suite passed all 13 tests. Its full
  unit suite passed 676 tests, the real-Chrome design suite passed 19 with one
  intentional skip, repeated fixtures passed 162, and MCP parity passed 21.
  The parity runner hit the repository's known post-run teardown stall after
  reporting all tests passed, so the remaining membership, contract, harness,
  build, and route smoke checks were run independently and passed.
- The workspace platform contract check passed.
