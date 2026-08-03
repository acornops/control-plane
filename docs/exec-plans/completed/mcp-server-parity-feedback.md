# MCP server parity and feedback

## Goal

Make Agent MCP server authentication and configuration honor the same common
contract already supported by Target MCP servers and the gateway.

## Constraints

- Preserve existing `/api/v1` routes and response envelopes.
- Keep Agent authorization, audit, schedule, and tool-review behavior intact.
- Do not change persistence schemas.

## Outcome

- Preserved OAuth during Agent MCP create and update operations.
- Accepted, validated, and forwarded public-header updates.
- Added controller regression coverage for OAuth and public headers.

## Validation

- `npm run validate` in the repository Docker environment with the test
  database, Redis, and a valid test webhook encryption key.
- Workspace platform-contract check.
