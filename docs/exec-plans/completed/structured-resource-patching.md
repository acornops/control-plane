# Structured Resource Patching

## Goal

Replace `simulate_patch` with `patch_resource` in the authenticated AgentK
session policy and mirrored six-tool catalog.

## Decisions

- Keep run-scoped authorization authoritative.
- Use discovery reconciliation to remove the stale built-in tool.
- Do not add a database migration or compatibility alias.

## Validation

- `npm run validate` passed, including 539 tests and contract/build checks.

## Completion Criteria

Control-plane validation and cross-repository contract checks pass.
