# Read Audit Remnant Cleanup

## Goal

Ensure read-only admin actions are neither written nor returned by Admin Audit,
including historical rows created by older local or deployed builds.

## Scope

- Keep mutation and authentication lifecycle audit writes unchanged.
- Exclude legacy `.read` and `.search` rows from producer query results without
  deleting append-only evidence.
- Add a route-level regression proving every registered admin GET handler is
  free of audit-write primitives.
- Keep producer and consumer contract policy aligned.

## Validation

- Five focused producer audit tests passed, including the registered-GET-handler
  audit-write guard and legacy-result exclusion assertions.
- Typecheck, style, contracts, OpenAPI, harness, build, and the workspace
  contract mirror check passed.
- The live local repository query returned 57 visible events and zero `.read` or
  `.search` actions while the 134 legacy rows remained stored.

## Completion

All registered admin GET handlers are free of audit-write primitives. Legacy
read/search rows are excluded at query time without deleting append-only data.
