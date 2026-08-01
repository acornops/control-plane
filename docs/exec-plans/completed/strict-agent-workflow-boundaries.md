# Strict Agent and Workflow Boundaries

## Goal

Enforce these production invariants across persistence, APIs, runtime dispatch,
gateway authorization, UI contracts, deployment, tests, and documentation:

1. Workspace Agents have no target identity, binding, scope, constraint, or
   target-specific capability field. A granted generic Targets MCP tool may
   accept `target_id` and `target_type` only as invocation arguments.
2. Workflows have no target identity, binding, scope, constraint, or
   target-specific capability field.
3. Agent and Workflow definitions have no version model, selector, claim, or
   header.
4. Direct Agent chat uses the neutral conversation runtime without Workflow
   definitions, sessions, executions, or runs. Workflows may assign Agents and
   consume their current capability snapshots; Agents do not invoke or depend
   on Workflow runtime.

## Completed work

- [x] Inventoried persisted fields, DTOs, JWT claims, execution requests,
  bootstrap payloads, LLM requests, tool calls, MCP routing, UI models,
  deployment configuration, fixtures, tests, and docs.
- [x] Replaced target-specific Agent capability fields with ordinary
  server-qualified MCP tool references.
- [x] Removed Workflow target projections, target-specific routing fields, and
  target prompt-resource providers.
- [x] Removed Agent and Workflow definition-version tables, columns, DTOs,
  selectors, claims, and headers. Greenfield migration checks explicitly reject
  their reintroduction.
- [x] Separated direct Agent chat from Workflow persistence and dispatch.
- [x] Limited the Agent/Workflow relationship to Workflow Agent assignment and
  immutable execution snapshots of the assigned Agents' current capabilities.
- [x] Made target, `agent_chat`, and workspace Workflow scopes mutually
  exclusive at the control-plane token boundary, execution-engine request and
  client boundaries, and LLM-gateway JWT/LLM/tool-call boundaries.
- [x] Restricted Workflow delegation inputs to `capabilityId`, `taskPrompt`, and
  `required`; unexpected resource or target bindings fail closed.
- [x] Preserved AgentK and AgentV connector release reporting through
  `x-connector-version` and `last_connector_version`.
- [x] Corrected deployment configuration to use
  `GENERATED_DOCUMENT_RETENTION_DAYS`; the obsolete report-retention variable
  would otherwise have silently ignored non-default production retention.

## Boundary evidence

- Live control-plane Agent and Workflow controllers, services, repositories,
  domain types, OpenAPI schemas, console API models, and console Agent/Workflow
  views contain no target identity or binding fields.
- `agent_definitions`, `workflow_definitions`, `workflow_executions`,
  `workflow_runs`, `workflow_sessions`, `workflow_schedules`, and Workflow
  webhook persistence contain no target columns and no Agent/Workflow
  definition-version columns.
- Neutral target-chat and Agent-chat session/run tables retain the target-chat
  variant, but database checks require Agent-chat rows to have `target_id IS
  NULL` and an exact Agent snapshot/access scope.
- Workflow dispatch sends workspace, Workflow execution/session, executor role,
  and specialist Agent identity only. Agent-chat dispatch sends workspace,
  session, run, and Agent identity only.
- The stable Targets MCP catalog adds `target_id` and `target_type` solely to
  generic tool input schemas. It is independent from workspace target
  inventory. Runtime routing validates and removes those call arguments before
  forwarding the operation to the selected connector.
- Intentionally retained version terminology is limited to connector releases,
  protocol/schema versions, MCP installation revisions and provenance, and
  negative migration/architecture guards. None version an Agent or Workflow
  definition.
- `target_agent_registrations` and related target-agent wording describe the
  AgentK/AgentV connector transport, not workspace Agent definitions.

## Validation

- Control plane: isolated migrated PostgreSQL full suite passed 1,087 tests;
  typecheck, style, build, authorization, membership, durable run-event,
  contracts, OpenAPI, harness, and greenfield SQL migration introspection
  passed.
- Execution engine: 233 tests and 29 keyless evaluations passed; lint,
  contracts, and harness passed.
- LLM gateway: 554 tests and 50 keyless evaluations passed; lint, contracts,
  and harness passed.
- AgentK: 250 tests and the loopback connector E2E passed.
- AgentV: 67 tests and all 4 connector E2E cases passed.
- Management console: 777 tests and production build passed during the full
  sweep; the changed fixture suite passed 8 tests and contracts/harness passed
  after final copy cleanup.
- Docs website: all 42 navigation pages and Mint build validation passed.
- Deployment: full validation, Kubernetes chart, contract, harness, install
  dry-run, release-matrix, and production exposure/image checks passed.
- Workspace cross-repository contracts, platform harness, runtime-truth checks,
  and `git diff --check` passed.
- Across the eight changed repositories, the final diff is net 152 lines
  smaller after including untracked additions (9,425 additions, 9,577
  deletions).

## Independent release gates

The management console still has pre-existing, clean-tree release gates outside
this boundary refactor: broad UI declaration failures in lint/typecheck, two
design-token violations in `NavCountBadge.tsx`, and a bundle budget overrun
(547,177 bytes versus 358,400). They are not caused by the Agent/Workflow
boundary changes and remain separately actionable before an unconditional
platform-wide production declaration.
