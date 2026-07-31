# Workspace Default Enabled State

## Goal

Persist a reversible enabled state for platform-owned MCP server and skill
definitions so disabled entries remain editable but are not copied into newly
created workspaces.

## Requirements

- Preserve the existing create, availability, delete, and detached-snapshot
  behavior.
- Default new definitions to enabled.
- Allow PATCH to change availability, enabled state, or both.
- Copy only enabled definitions during workspace creation.
- Keep existing workspace snapshots unchanged.
- Expose and document the field without leaking skill contents or credentials.

## Progress

- [x] Extend the database, types, validation, repository, controller, and
  OpenAPI contract.
- [x] Filter workspace initialization to enabled definitions.
- [x] Update the cross-repository contract manifest.
- [x] Run focused and repository validation.

## Validation Log

- Focused workspace-default contract tests passed (5 tests).
- Typecheck, style, migration, authorization, membership, run-event, contract,
  harness, OpenAPI, and build checks passed.
- The generated admin OpenAPI artifact and workspace cross-repository contract
  check passed.
- Database-backed introspection was not run because
  `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` is not configured. The full test
  stage also requires a local PostgreSQL service, which was unavailable at
  `127.0.0.1:5432`; static migration coverage and focused changed-path tests
  passed.

## Completion Criteria

- Contract tests accept boolean enabled-only PATCH requests and reject empty
  updates.
- Static and database-backed tests prove disabled definitions are skipped.
- Control Plane validation passes, or any environment-only skipped check is
  recorded.
