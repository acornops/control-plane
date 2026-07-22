# Target capability inventory parity

## Goal

Keep user-visible target-chat capabilities discoverable in the matching Cluster
Tools, MCP, or Skills inventory without exposing internal runtime helpers.

## Boundaries

- Platform-native target-chat tools are control-plane-owned and target-neutral.
- MCP inventory and runtime resolution continue to share the gateway target
  catalog, with runtime applying enabled and authorization filters.
- Skills inventory and runtime continue to share the target skill store, with
  runtime loading only enabled, valid skills.
- Internal model-only helpers remain absent from user-facing inventories.

## Verification

- Catalog/runtime parity tests for platform-native target-chat tools.
- Target tool controller and management-console inventory tests.
- Control-plane and management-console contract checks.

## Outcome

- Target-chat platform-native runtime resolution and Cluster Tools now use the
  same invocation-scope selector.
- The target tool contract exposes `origin`, and platform-native entries are
  always enabled and non-configurable.
- MCP and Skills source/runtime parity was audited with no additional inventory
  defect; their runtime filters remain intentional.
- Focused controller/runtime tests, typecheck, and contract checks pass.
