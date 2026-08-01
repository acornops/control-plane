# Agent chat production audit

Status: completed 2026-08-01

## Goal

Perform a clean-room production-readiness audit of the neutral direct Agent-chat
runtime without changing Workflow specialist semantics or Agent definition
history.

## Outcome

- Removed the remaining hidden Workflow-carrier schema, repository, compiler,
  cleanup, and compatibility paths from the greenfield baseline.
- Kept direct conversations bound to Agent identity while each run resolves the
  current Agent and freezes its effective instructions, tools, skills, model,
  principal, permissions, and resource authority.
- Hardened scope and bootstrap identity matching, target-route narrowing,
  target-constrained attachment handling, live tool-operation matching, MCP
  alias/operation matching, and unresolved-tool fail-closed behavior.
- Made conversation mode changes affect future runs without invalidating an
  already-pinned run.
- Serialized Agent deletion with its final active-run guard and external MCP
  cleanup so a concurrent direct run cannot be created in the gap.
- Preserved Workflow definition, schedule, execution, delegation, specialist,
  approval, and token semantics; affected Workflow regressions pass.

## Validation

- `npm run validate` passes, including 1,081/1,081 tests, greenfield migration
  SQL checks, authorization, membership, run-event durability, contracts,
  public/admin OpenAPI coverage, harness checks, and build.
- Migrations `001` through `007` apply cleanly to an isolated PostgreSQL 16
  database, with carrier/version-era absence assertions passing.
- The final affected Agent-chat and Workflow regression selection passes 34/34.
- An isolated Docker integration project started the control plane, execution
  engine, and LLM gateway; all three health endpoints returned HTTP 200.

## Residual repository checks

The neutral runtime has no known failing check. Workspace-wide validation still
reports two unrelated concurrent-worktree issues: the management-console design
validator flags `NavCountBadge` typography, and the Kubernetes RBAC additions
counterpart manifest is not yet synchronized between the control plane and
console.
