# Mattermost Account Link Contract

## Goal

Implement the control-plane producer contract for Mattermost account linking:

- `POST /api/v1/auth/chat/mattermost/link`
- `POST /api/v1/auth/chat/mattermost/link/complete`
- `POST /api/v1/auth/chat/mattermost/resolve`

## Constraints

- External Mattermost integration clients authenticate with `MATTERMOST_CHAT_SERVICE_TOKEN`.
- The external integration may resolve a durable Mattermost identity link, but it must not assert an AcornOps user.
- Only an authenticated AcornOps browser session may complete the link through the Mattermost browser completion endpoint.
- External integration clients must never receive browser cookies, OIDC access tokens, ID tokens, or refresh tokens.
- Link tokens are short-lived, stored only as hashes, and consumed when the durable link is completed.

## Decision Log

- Store pending Mattermost link tokens in `mattermost_link_tokens` with the Mattermost user id, token hash, expiry, and consumption timestamp.
- Store durable account links in `mattermost_user_links` with the Mattermost user id, AcornOps user id, linked timestamp, last authenticated timestamp, expiry, and revocation timestamp.
- Return a management-console URL at `/integrations/mattermost/link?token=<mattermost-link-token>` so browser login remains user mediated.
- Keep OIDC and password login as session-establishment flows; classify Mattermost-originated OIDC state as `integration_link`, then complete Mattermost linking afterward through the shared authenticated browser completion endpoint.

## Validation Log

- `node --import tsx --test test/mattermost-link.test.ts`
- `npm run contracts:check`
- `npm run openapi:check`
- `npm run validate`

## Completion Criteria

- Service-token protected create and resolve endpoints are implemented.
- Browser link completion consumes a pending token only after a normal browser session exists.
- Contract docs/OpenAPI manifest include the new endpoints, Mattermost user id field, and auth rules.
- Targeted tests cover token creation, OIDC prevalidation and return routing, session completion, resolve behavior, and service-token enforcement.
