# Admin Audit Subject Display Name

## Goal

Expose an optional readable display name for user subjects in platform admin
audit responses without replacing the immutable subject ID.

## Constraints

- Keep `subjectId` unchanged as immutable audit evidence.
- Resolve names server-side so audit-only consumers do not need user-directory
  scope or per-row user lookups.
- Add no route, query, authentication, or mutation behavior.
- Preserve compatibility for old events and missing users by making the field
  optional.

## Decision log

- Join user subjects at read time, matching the existing workspace-name
  enrichment pattern and avoiding a database migration.
- Add `subjectDisplayName` to the OpenAPI schema and mirrored manifests.

## Validation plan

- Extend repository coverage for the user-subject join and mapped response.
- Run typecheck, contract checks, OpenAPI export/check, and repository
  validation.
- Run the workspace platform-contract check with the consumer change.

## Validation results

- Focused readable-identity repository test — passed.
- Typecheck and style checks — passed.
- Contract, OpenAPI, harness, migration-static, authorization, membership,
  run-event, and build checks — passed.
- Workspace platform-contract check — passed.
- Full `npm run validate` could not complete because this workspace has no
  Postgres service listening on `localhost:5432`; the database-dependent broad
  suite failed with `ECONNREFUSED`. No failure involved the changed audit
  repository test.

## Completion

The optional field is backward-compatible and read-only. Immutable subject IDs
remain unchanged, and old or deleted-user events can omit the display name.
