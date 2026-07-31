# Workflow sections and Activity

## Goal

Replace the workflow event-trigger capability with signed workflow webhooks, preserve
durable execution and audit history through a forward migration, and publish the
renamed contract for the management console and public API documentation.

## Constraints

- Keep low-level run APIs and storage unchanged.
- Remove AcornOps event-trigger creation and dispatch.
- Preserve historical workflow executions and workspace audit records.
- Keep webhook signature verification, replay protection, rate limiting, and
  one-time secret disclosure intact.
- Land the producer contract before its console and docs consumers.

## Validation plan

- Targeted webhook security, migration, workflow activity, and contract tests.
- `npm run validate`
- Workspace platform-contract check with the coordinated console and docs
  worktrees.

## Completion criteria

- Workflow webhook routes, DTOs, worker, persistence, provenance, OpenAPI, and
  manifest use workflow-webhook terminology.
- A forward migration retains webhook configuration and execution/audit
  history while removing the retired AcornOps event capability.
- Generated public OpenAPI artifacts match the producer.
