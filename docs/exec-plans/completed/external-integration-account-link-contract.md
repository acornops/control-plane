# External integration account link contract

## Goal

Implement the control-plane producer contract for external integration account linking:

- `POST /api/v1/auth/chat/integration/link`
- `POST /api/v1/auth/chat/integration/link/complete`
- `POST /api/v1/auth/chat/integration/resolve`

## Constraints

- external integration clients authenticate with `EXTERNAL_INTEGRATION_SERVICE_TOKEN`.
- The external integration may resolve a durable external identity link, but it must not assert an AcornOps user.
- Only an authenticated AcornOps browser session may complete the link through the external integration browser completion endpoint.
- External integration clients must never receive browser cookies, OIDC access tokens, ID tokens, or refresh tokens.
- Link tokens are short-lived, stored only as hashes, and consumed when the durable link is completed.

## Decision Log

- Store pending external integration link tokens in `external_integration_link_tokens` with the external user id, token hash, expiry, and consumption timestamp.
- Store durable account links in `external_integration_user_links` with the external user id, AcornOps user id, linked timestamp, last authenticated timestamp, expiry, and revocation timestamp.
- Return a management-console URL at `/integrations/external-chat/link?token=<external-chat-link-token>` so browser login remains user mediated.
- Keep OIDC and password login as session-establishment flows; classify external-integration-originated OIDC state as `integration_link`, then complete external integration linking afterward through the shared authenticated browser completion endpoint.

## Validation Log

- `node --import tsx --test test/external-integration-link.test.ts`
- `npm run contracts:check`
- `npm run openapi:check`
- `npm run validate`

## Completion Criteria

- Service-token protected create and resolve endpoints are implemented.
- Browser link completion consumes a pending token only after a normal browser session exists.
- Contract docs/OpenAPI manifest include the new endpoints, external user id field, and auth rules.
- Targeted tests cover token creation, OIDC prevalidation and return routing, session completion, resolve behavior, and service-token enforcement.
