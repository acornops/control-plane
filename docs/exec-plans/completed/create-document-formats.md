# Create document formats

## Goal

Generalize the workspace-native PDF report function into a document-creation
function that can return either PDF or Markdown artifacts.

## Boundaries

- Keep document rendering, retention, provenance, authorization, idempotency,
  and downloads in the control plane.
- Keep target adapters free of document-rendering behavior.
- Preserve PDF as the default output format for callers that omit `format`.

## Verification

- Control-plane typecheck, contract checks, and greenfield migration checks
  passed.
- Agent and target tool-resolution tests passed.
- Management-console application typecheck, contract checks, and affected chat
  artifact/API tests passed.
- Database-backed artifact tests were updated but not run because this workspace
  does not provide `CONTROL_PLANE_TEST_DATABASE_URL`.

## Outcome

- Replaced `reports.pdf.generate` / `acornops_generate_pdf_report` with
  `documents.create` / `acornops_create_document` across native-tool routing
  and focused contracts.
- Added optional `format: "pdf" | "markdown"`; omitted format continues to
  create PDFs.
- Persisted Markdown artifacts as `text/markdown` and downloads them as `.md`;
  PDF rendering remains unchanged.
