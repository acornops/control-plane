# Generated document route cleanup

## Goal

Replace the report-artifact HTTP API with a document-named breaking API that
matches the PDF and Markdown document feature.

## Boundaries

- Remove the legacy report-artifact routes rather than providing aliases.
- Keep authorization, retention, and download rendering unchanged.
- Align runtime URLs, response fields, OpenAPI, consumer contracts, and public
  documentation.

## Verification

- Control-plane typecheck, contract, and OpenAPI checks passed.
- Management-console typecheck, contract, and generated-document chat tests
  passed.
- Docs website checks passed.
- The database-backed external-integration controller test remains blocked by
  the unavailable `CONTROL_PLANE_TEST_DATABASE_URL`.

## Outcome

- Replaced `/report-artifacts/{reportId}` with the breaking
  `/generated-documents/{documentId}` API and removed the former route.
- Renamed the metadata response from `{ report: ... }` to `{ document: ... }`.
- Aligned runtime URLs, OpenAPI, counterpart contracts, UI code, and public
  documentation with PDF and Markdown document support.
