# Virtual Machine Agent readiness

## Goal

Make the default Virtual Machine Agent ready on a fresh read-only AgentV setup
without weakening the strict Agent readiness contract.

## Decisions

- Remove `infrastructure.remediation.write` from the starter VM Agent because
  `restart_service` is optional and disabled in a default AgentV installation.
- Keep all default AgentV diagnostic tools enabled through
  `infrastructure.diagnostics.read`.
- Keep `restart_service` enabled in the target MCP catalog when AgentV actually
  advertises it, but require an administrator to grant VM remediation explicitly
  before a workspace Agent can use it.
- Increment the starter bundle version without overwriting existing
  workspace-owned definitions.

## Work

- [x] Correct the starter Agent capability ceiling and fixtures.
- [x] Add regression expectations for the read-only VM ceiling.
- [x] Clarify public documentation.
- [x] Run focused and database-backed validation.

## Validation

- Starter template and development seed tests: 3 passed.
- Control-plane typecheck and build passed.
- PostgreSQL Workflow/Agent foundations: 5 passed, including a regression that
  makes a read-only VM target mapping and asserts the starter VM Agent is ready.
- Control-plane style, migrations, authorization, membership, run-event,
  contract, and harness checks passed.
- Management-console fixture tests: 8 passed; UI package typecheck passed.
- Docs build validation and broken-link checks passed.
- Workspace runtime-truth checks passed.
