# Interactive PDF report artifacts

## Goal

Make the code-owned `reports.pdf.generate` capability callable from interactive
target chats as well as workflows, without turning report rendering into an
AgentK or AgentV tool.

## Boundaries

- Control-plane owns bounded rendering, retention, provenance, authorization,
  idempotency, auditing, and authenticated downloads.
- Execution-engine routes platform-native function calls back to the control
  plane; exact MCP references remain mandatory for MCP tools.
- Kubernetes, VM, and future target adapters do not render or store PDFs.
- A chat response action exports the persisted assistant response directly; it
  does not spend another model turn or ask the model to reproduce the answer.

## Verification

- Target and workflow platform-tool routing tests.
- Interactive export authorization, idempotency, retention, and size tests.
- Management-console API and contextual-action tests.
- Contract checks in control-plane, execution-engine, and management-console.
- Workspace platform-contract validation.

## Delivery

Shared branch: `feat/extensible-catalog-sources`.
Merge order: control-plane, execution-engine, management-console.

## Outcome

- Added target-run artifact ownership, idempotency, retention, public export,
  generic authenticated download routes, and service-authenticated native-tool
  execution.
- Kept PDF rendering and storage above the target-adapter boundary and added
  multipage output.
- Verified typecheck, contract and migration checks, OpenAPI coverage, route
  isolation, target tool resolution, artifact idempotency, persisted-source
  export, and PDF structure. An independently generated artifact also passed
  `pdfinfo` parsing as PDF 1.4.
