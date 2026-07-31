# Admin Audit Workspace Query

## Goal

Allow the protected Admin Audit list to filter by either an exact workspace ID
or a case-insensitive workspace-name substring without weakening the existing
query, pagination, or confidentiality boundaries.

## Scope

- Add an optional `workspaceQuery` filter to the admin audit controller,
  repository, OpenAPI contract, and mirrored manifests.
- Keep `workspaceId` as the backward-compatible exact-ID filter.
- Parameterize name matching and include the new value in the cursor signature.
- Update the Platform Admin BFF allowlist, local mock, UI, requirements, and
  tests.
- Refresh the checked-in admin OpenAPI artifact.

## Validation

- Focused control-plane controller and repository tests passed (18 tests).
- Control-plane type, style, contract, OpenAPI, harness, and build checks
  passed.
- Platform Admin Console full validation passed (79 tests).
- Docs website validation and link checks passed with bundled Node 24.
- Workspace cross-repository contract check passed.
- A live local database spot check was unavailable because PostgreSQL was not
  listening on port 5432. Repository SQL generation and the end-to-end mock BFF
  path cover both name and ID behavior.
