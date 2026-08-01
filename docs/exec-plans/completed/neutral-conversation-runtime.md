# Neutral conversation runtime

Status: completed 2026-08-01

## Goal

Move direct Agent chat off the hidden system-managed Workflow carrier and onto
the same neutral interactive-conversation runtime used by target chat, while
preserving origin-specific Agent and target capability resolution.

## Compatibility boundary

- Workflow definitions, sessions, messages, executions, runs, schedules,
  triggers, coordination, public APIs, and persistence semantics remain
  unchanged.
- Existing Agent-conversation public routes remain stable; response lifecycle
  fields now describe the neutral conversation directly instead of exposing a
  synthetic Workflow execution identity.
- This is a direct cutover for Agent chat. The greenfield baseline contains no
  carrier columns or carrier-data path; real Workflow definitions and
  executions remain unchanged.
- Target-chat behavior remains stable while its persistence and run services
  become origin-neutral.
- Execution-engine run lifecycle, event ordering, cancellation, idempotency,
  and terminal commit semantics remain stable.

## Decisions

- Interactive conversations have an explicit origin: `target_chat` or
  `agent_chat`.
- Common session, message, run, event, approval, artifact, retention, and
  deletion mechanics live below origin-specific adapters.
- Target conversations bind to an exact target. Agent conversations bind to an
  Agent identity and resolve the latest active Agent definition at each run.
- Every run persists an immutable effective Agent/target, model, instruction,
  tool, and authorization snapshot.
- Conversation access mode is a preference and ceiling input; effective access
  is recomputed for each run using current actor and subject policy.
- Agent chat dispatches directly as an `agent_chat` execution scope and never
  creates or mutates a Workflow definition.

## Completed work

1. Added explicit `target_chat` and `agent_chat` origins to neutral sessions
   and runs, including Agent binding, immutable Agent snapshot, compiled scope,
   lifecycle status, and expiry persistence.
2. Routed Agent conversation create/read/list/delete/message operations through
   the neutral repositories and direct run dispatcher. New Agent chat no longer
   creates Workflow definitions, sessions, executions, or runs.
3. Added Agent-origin bootstrap, signed scope claims, dynamic target-tool route
   handling, approvals, native tools, events, commit, cancellation, retention,
   and deletion support while retaining origin-specific side effects.
4. Split shared scope/contract/mapping helpers and origin-specific Agent and
   Target bootstrap adapters so the common runtime stays neutral and all
   enforced file-ownership budgets remain satisfied.
5. Updated the public Agent contract: lifecycle status/expiry are explicit and
   message creation no longer exposes a synthetic Workflow execution ID.

## Security invariants

- Only the conversation creator may continue or mutate a manual conversation;
  workspace readers may inspect it.
- Each run intersects current user permissions, Agent permission policy,
  session preference, and requested access mode.
- Capability additions never affect an active run. Capability removals are
  effective for the next run and cannot expand authority.
- Message, tool, artifact, and approval lookups bind to the exact workspace,
  conversation, run, and origin.
- Prompt bodies, tool arguments, credentials, and generated document bytes are
  not added to audit metadata or logs.

## Validation results

- `npm run typecheck`, `npm run style:check`, `npm run migrations:check`,
  `npm run authz:check`, `npm run membership:check`,
  `npm run run-events:check`, `npm run openapi:check`,
  `npm run contracts:check`, `npm run harness:check`, and `npm run build`
  pass.
- Migration `001` through `007` applies cleanly to an isolated PostgreSQL 16
  database; the migration SQL introspection check passes.
- Agent native-tool/artifact/approval/skill snapshot coverage passes against an
  isolated database. Focused Agent and Workflow follow-up regression coverage
  passes 7/7.
- The complete control-plane test command passes against a clean isolated
  PostgreSQL database with no failed tests.
- Public and admin OpenAPI coverage and the Agent-chat contract inventories
  agree across the control plane, execution engine, LLM gateway, and console.

## Completion criteria

- New Agent conversations create no `workflow_definitions`,
  `workflow_sessions`, `workflow_executions`, or `workflow_runs` records.
- Agent chat and target chat use neutral conversation/message/run contracts.
- Agent changes are resolved per new run and pinned on that run.
- Agent conversations expire and delete through the common lifecycle and
  expose the common lifecycle status.
- Existing Workflows pass unchanged regression and contract suites.

## Outcome

All implementation criteria for the neutral conversation runtime are met. The
execution engine and LLM gateway accept `agent_chat`; the management console
and generated public OpenAPI consume the updated Agent contract. Deployment
must keep the downstream scope consumers ahead of the control-plane cutover.
