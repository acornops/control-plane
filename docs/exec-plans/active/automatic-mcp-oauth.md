# Automatic MCP OAuth

## Goal

Expose authenticated Agent and target MCP OAuth preparation/start/status/verify
and disconnect APIs while keeping provider credentials and protocol decisions in
llm-gateway.

## Decisions

- Only the signed-in user can manage an individual OAuth connection.
- The callback requires both the initiating AcornOps session and a reusable
  secure browser-binding cookie.
- The browser receives only safe issuer/scope/registration metadata and the
  short-lived authorization redirect from an explicit start operation.
- Provider callback errors are converted to stable AcornOps result codes.

## Work

- [x] Extend the gateway client and MCP connection controller.
- [x] Add Agent and target prepare/start routes and the public callback/CIMD
  endpoint.
- [x] Add browser binding, return-path validation, auditing, contracts, and
  tests.
- [x] Update operations/security documentation.

## Validation

- OAuth controller and routing tests: 14 passed.
- Full control-plane test suite against an isolated PostgreSQL database:
  1,035 passed.
- Typecheck, style, build, authorization, membership, run-event, migration,
  contract, OpenAPI, and harness checks: passed.

## Cross-repository dependency

Consumes the llm-gateway contract and produces the management-console contract.
Merge after llm-gateway and before management-console/deployment.
