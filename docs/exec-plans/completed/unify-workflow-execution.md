# Unify Workflow Execution

## Goal

Make `workflow_runs` the only automation execution record. Model direct,
coordinated, and delegated execution with `specialist` and `coordinator`
executor roles and parent/child run topology.

## Decisions

- Agents are specialist capability profiles and never own runs.
- Coordinators are versioned runtime profiles, not persisted Agents.
- Remove Agent activity/events/triggers, Manager fields, entry Agents,
  Workflow delegation persistence, and duplicate approval stores.
- Use `execution_id` for the logical Workflow occurrence and `id` for each run.
- Rewrite the greenfield baseline schema; no compatibility or data migration.

## Validation

- The canonical validation stages passed, including 838 tests and live SQL
  migration introspection against a recreated test database.
- `docker compose --profile integration up -d --build`: passed after recreating
  the disposable integration volumes; control plane, LLM gateway, and execution
  engine reached healthy status.
- Targeted architecture, typecheck, style, contract, OpenAPI, harness, and
  greenfield-schema checks passed. Dispatch/cancellation race and coordinator
  child-cancellation regressions also passed.
- Workspace runtime-truth and cross-repository contract checks: passed.
