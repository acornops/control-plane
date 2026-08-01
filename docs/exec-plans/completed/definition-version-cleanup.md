# Agent and Workflow definition version cleanup

Status: completed

## Goal

Remove Agent and Workflow definition versions as product and runtime concepts.
Definitions are mutable resources identified by stable IDs; each accepted run
persists immutable definition, executor, capability, and authorization
snapshots.

## Boundaries

- New Agent-chat runs resolve the current Agent.
- New Workflow sessions and trigger occurrences resolve the current Workflow
  and current selected Agents.
- Existing interactive Workflow sessions retain their Workflow snapshot for
  conversational consistency; selected Agents are resolved for each run.
- Active runs continue exclusively from their persisted snapshots.
- Target connector package releases remain diagnostic metadata, renamed so
  they cannot be confused with Agent definitions.
- Protocol and schema versions are outside this cleanup.

## Work

1. Remove Agent definition counters, manual version history, mapping version
   coupling, specialist-run version claims, and public/UI surfaces.
2. Replace version-based mapping invalidation with explicit, transactional
   mapping reconciliation for capability-affecting Agent changes.
3. Remove Workflow definition counters and propagation through sessions,
   executions, triggers, claims, contracts, logs, and public surfaces.
4. Rename the connector release header and stored connection metadata
   terminology across AgentK, AgentV, the control plane, and contracts.
5. Sweep for dead helpers, duplicated validation, stale documentation, and
   unnecessary compatibility branches.
6. Measure the coordinated diff and run targeted plus full validation.

## Completion criteria

- No Agent or Workflow definition version remains in runtime, persistence,
  public contracts, UI, tests, or docs.
- Capability mappings cannot authorize removed or unreviewed Agent
  capabilities.
- Sessions and runs retain sufficient immutable snapshots for audit and stable
  in-flight execution.
- Connector release metadata is clearly separated from Agent identity.
- The cleanup reduces production code and contract surface where practical;
  any net line growth is explained by tests or migration evidence.

## Outcome

- Removed Agent and Workflow definition version fields, persistence, history
  routes, restore-point UI, runtime claims, trigger/session propagation, tests,
  and documentation.
- Replaced mapping-version coupling with transactional review invalidation only
  when Agent capability configuration actually changes. Immutable session and
  run snapshots remain the execution and audit boundary.
- Renamed target connector release metadata from Agent-version terminology to
  connector-version terminology across the control plane, AgentK, AgentV, and
  deployment contracts.
- Fixed every stale assertion and SQL reference exposed by a complete
  PostgreSQL-backed control-plane sweep. The seven remaining container-run
  failures were isolated to production-like MFA, email, and OIDC environment
  overrides; their exact 28 tests pass under the intended test environment.
- Passed fresh-schema PostgreSQL introspection, all affected database-backed
  tests, type/style/contract/OpenAPI/harness/build gates, management-console
  unit and affected browser tests, execution-engine and LLM-gateway validation, AgentK and AgentV
  validation, documentation validation, and deployment validation.
- Reduced the coordinated worktree from the approximately +2,959 net lines
  measured before this cleanup to +1,867. Tracked changes are net -352 lines;
  the remaining positive balance is primarily the earlier neutral Agent-chat
  runtime, its tests, and required execution-plan records rather than retained
  definition-version machinery.
