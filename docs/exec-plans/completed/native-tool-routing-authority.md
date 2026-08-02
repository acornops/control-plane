# Native Tool Routing Authority

## Goal

Prevent coordinated Workflow readiness and launch from requiring a second
reviewed routing record when a selected Agent already has a control-plane-owned
workspace-native tool assigned.

## Plan

- Derive reviewed routing snapshots for assigned workspace-native tools when no
  explicit active reviewed mapping exists.
- Use the same resolved mapping set for readiness, previews, interactive runs,
  scheduled/webhook dispatch, and Agent conversations.
- Preserve explicit reviewed mappings and the existing review gate for MCP,
  skill, and other semantic capability routes.
- Add regression coverage and update the producer/consumer contract notes.

## Validation

- Targeted routing-resolution and workflow tests.
- `npm run validate` in `control-plane`.
- Platform contract mirror check from the workspace root.

## Outcome

- Assigned workspace-native tools now derive active reviewed routing snapshots
  for readiness, previews, interactive launch, trigger dispatch, delegation,
  and Agent conversations when no explicit reviewed mapping exists.
- Workflow readiness, preview, launch, and trigger dispatch now share one loaded
  routing snapshot instead of independently reloading and rechecking Agents and
  mappings. The access compiler retains its fail-closed boundary validation.
- External MCP, skill, and other semantic routes retain their separate reviewed
  mapping requirement.
- The focused unit test and database-backed native-tool regression passed.
- The full suite passed 1,098 of 1,099 tests; the unrelated Agent Targets MCP
  synchronization test timed out under suite load and passed immediately in
  isolation. Typecheck, style, migration static checks, authorization,
  membership, run-event durability, contracts, OpenAPI, harness, and build all
  passed.
- The control-plane and management-console contract checks passed. The root
  platform-contract mirror checker could not start because this workspace is
  missing `control-plane/test/fixtures/workflow-template-conformance.json`.
