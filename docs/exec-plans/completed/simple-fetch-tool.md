# Simple Fetch Tool

## Goal

Add one configurable, workflow-only `http.fetch.get` workspace-native tool.
Agents may grant up to 20 public HTTPS URL patterns and the model may issue only
bounded GET requests that match the run-snapshotted patterns.

## Work

- Add Agent-native tool configuration persistence and contract fields.
- Normalize and match exact/path-query wildcard URLs.
- Execute SSRF-safe, DNS-pinned GET requests through the control plane.
- Add runtime, assignment, snapshot, audit, and contract regression coverage.
- Coordinate the management-console editor and mirrored consumer contracts.

## Constraints

- No API-connection resource, credentials, headers, body, parameter editor, or
  non-GET method.
- Reuse the webhook public-egress and pinned-DNS primitives.
- Keep the tool on the existing platform-function transport and out of target
  adapters, the LLM gateway, AgentK, and AgentV.
- Never write full URLs, query values, or response bodies to audit records,
  metrics, logs, or durable run events.

## Decision Log

- The greenfield repository owns one numbered SQL baseline, so
  `native_tool_configs` is part of `001_initial_schema.sql` rather than a second
  numbered migration.
- Configuration is accepted by the existing native-tool PUT route and copied
  into each compiled Workflow run scope.
- Non-2xx HTTP responses are returned as fetched data; redirects and transport
  policy failures are tool errors.
- Execution-engine redacts Fetch run events to bounded response metadata while
  retaining the full response only in transient model context.

## Validation

- Full `npm run validate` passed against a fresh isolated PostgreSQL test
  database: 852 tests plus type, style, migration, authorization, membership,
  run-event durability, contract, OpenAPI, harness, and build checks.
- Fetch policy, response, assignment, snapshot, mapping-version, and metrics
  regressions passed within that suite.
- Workspace platform contract check passed.

## Completion Criteria

- Catalog, assignment, persistence, run snapshots, executor, safe telemetry,
  OpenAPI, mirrored contracts, and regression coverage agree on
  `http.fetch.get`.
