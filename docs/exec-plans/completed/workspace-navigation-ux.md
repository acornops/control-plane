# Workspace Navigation UX

## Goal

Support a shared, permission-aware workspace navigation system with an exact
pending-approval signal while preserving every existing workflow, schedule,
approval, and schedule-creation deep link.

## Repository Role

The control plane is the contract producer. Extend the workspace approval inbox
response with a required `pendingCount`, calculated across persisted target-tool
approvals and workflow-gate approvals before pagination and independently of the
requested list filter.

## Constraints

- Preserve existing authorization, error middleware, routes, and health dependencies.
- Count persisted target-tool approvals efficiently in the repository.
- Do not fetch every approval page to compute the total.
- Keep the response change additive and deploy this producer before the console.
- Record approval-inbox query outcome and duration without logging approval content.

## Validation Plan

- Targeted approval controller and repository tests covering zero, mixed-source,
  over-99, workspace isolation, pagination, filters, and authorization.
- `npm run contracts:check`
- `npm run openapi:check`
- `npm run validate`
- `node scripts/harness/check-platform-contracts.mjs` from the workspace root.

## Completion Criteria

- The approval response, OpenAPI schema, and contract manifest agree on required
  `pendingCount: number`.
- Count semantics are independent from pagination and list filtering.
- Query outcome and duration telemetry cover success and failure paths.
- Validation evidence and producer-first rollout notes are recorded in handoff.

## Validation Log

- Targeted approval controller, repository, and metrics tests passed.
- `npm run typecheck`, `npm run style:check`, `npm run migrations:check`,
  `npm run authz:check`, `npm run membership:check`,
  `npm run run-events:check`, `npm run contracts:check`,
  `npm run openapi:check`, `npm run harness:check`, and `npm run build` passed.
- `npm run validate` reached 541 passing tests and one unrelated failure in
  `test/utils/pagination.test.ts`: the pre-existing dirty pagination
  implementation returns `50` for a zero limit while the unchanged test expects
  `1`. The navigation change does not modify that behavior or test.
- Workspace platform-contract and validation entrypoints passed.
