# Runtime boundary verification

Status: completed 2026-08-01

## Goal

Verify and enforce four platform invariants before production:

1. Direct Agent chat is independent from Workflow execution.
2. Workflows are independent from target-chat resources and target identity.
3. Agent and Workflow definitions are not bound to targets; target access is
   selected per call and routed only through the generic Targets MCP facade.
4. AgentK and AgentV still authenticate and connect successfully while
   reporting their connector software release to the control plane.

## Completed work

1. Traced persistence, public and internal contracts, run claims, bootstrap,
   dispatch, approvals, gateway authorization, lifecycle, and UI projections.
2. Consolidated neutral interactive-conversation expiry, idempotency lookup,
   run selection, deletion guards, LLM validation, bootstrap policy, and
   dispatch mechanics while retaining origin-specific policy and side effects.
3. Removed stale target-provider and target-bound Workflow assertions. Generic
   Targets MCP calls now carry `target_id` and `target_type` only at invocation
   and validate both against the current workspace target.
4. Kept Agent readiness and Workflow readiness independent from target
   inventory and connector lifecycle. The stable Targets MCP catalog is
   projected from reviewed generic tool references; exact target availability
   and connector support are checked only when a tool is invoked.
5. Preserved `x-connector-version` as connector release metadata for AgentK
   and AgentV and kept it separate from Agent definition identity.

## Validation results

- The complete control-plane suite passed against an isolated PostgreSQL
  database: 1,086 tests, 0 failures.
- Control-plane type, style, build, authz, membership, run-event, contract,
  harness, public/admin OpenAPI, migration static, and migration SQL
  introspection checks passed.
- Execution engine passed lint, contracts, harness, and 221 tests.
- LLM gateway passed lint, contracts, harness, and 547 tests.
- AgentK passed its canonical validation, 250 unit tests, and its loopback
  WebSocket E2E test. AgentV passed its canonical validation, 67 unit tests,
  and four loopback WebSocket E2E tests.
- Management console passed lint, contracts, harness, and 781 tests.
- Public documentation passed structural, build, and broken-link validation.

## Outcome

- Agent-chat runs carry Agent identity and immutable Agent execution snapshots,
  but no Workflow or target identity.
- Workflow runs use only Workflow persistence and carry no target binding.
- Target chat remains target-bound and retains its target-specific capability,
  activity, webhook, and insights behavior.
- Agents and Workflows can operate in workspaces with no targets. If a model
  invokes a generic Targets MCP tool, that individual call must select a valid
  current workspace target.
- AgentK/AgentV release versions reach the target registration as
  `last_connector_version`; no Agent or Workflow definition version remains.
