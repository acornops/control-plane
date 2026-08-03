# Standardize tool-name capitalization

## Goal

Present every first-party tool name with consistent title capitalization across
the control-plane catalog, management console, and public documentation.

## Scope

- Change the canonical `documents.create` display name from `Create document`
  to `Create Document`.
- Update console fixtures and browser expectations that mirror the catalog.
- Update the matching target-chat documentation reference.
- Audit other first-party tool names without rewriting action copy, prose,
  user-authored names, or third-party MCP metadata.

## Compatibility

The tool ID, model alias, schemas, authorization, and runtime behavior remain
unchanged. Only the human-readable catalog title changes, so existing clients
remain compatible.

## Validation

- Focused control-plane native-tool test passed.
- Focused management-console service and browser tests passed.
- Full control-plane-independent checks, contracts, OpenAPI coverage, harness,
  and build passed. The full test command could not complete successfully
  because database-backed suites require `CONTROL_PLANE_TEST_DATABASE_URL`.
- Full management-console validation passed in control-plane mode.
- Documentation structure, Mintlify build, and broken-link checks passed.
- Cross-repository platform contract checks passed.

## Outcome

- `documents.create` now uses `Create Document` everywhere its first-party tool
  name appears in the API, console fixtures, accessibility assertions, browser
  tests, and user documentation.
- `Web Search`, `Insights`, and `Fetch` were already consistent and required no
  changes.
- Action copy, prose, arbitrary MCP metadata, workflow names, and skill names
  remain sentence-cased according to their own content rules.
