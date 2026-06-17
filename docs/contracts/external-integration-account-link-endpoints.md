# External integration account link endpoints

This document defines the AcornOps-owned HTTP contract for external integration account
linking. External integration client-side command handling, message rendering, event handling,
and retry behavior belong outside AcornOps.

## Integration Configuration

External integration clients call the control-plane API with:

- `ACORNOPS_API_BASE_URL`, for example `https://api.acornops.dev`.
- `EXTERNAL_INTEGRATION_SERVICE_TOKEN`, matching the control-plane
  `EXTERNAL_INTEGRATION_SERVICE_TOKEN`.
- An external user id supplied as `externalUserId`.

The integration token is valid only for the external integration account-link endpoints.
It is not a browser session, admin token, run token, or orchestrator service
token.

## Create Link

Creates a short-lived AcornOps link for an external user id.

Request:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/chat/integration/link
Authorization: Bearer {EXTERNAL_INTEGRATION_SERVICE_TOKEN}
Content-Type: application/json
```

Body:

```json
{
  "externalUserId": "external-user-id"
}
```

Successful response:

```json
{
  "linkUrl": "https://console.acornops.dev/integrations/external-chat/link?token=intlink_...",
  "expiresAt": "2026-06-09T00:00:00.000Z"
}
```

AcornOps returns a management-console URL in `linkUrl`. External integrations
should treat the URL and embedded token as short-lived bearer secrets and avoid
logging them in normal logs.

Creating a new link for the same `externalUserId` supersedes any previous
unconsumed, unexpired link token for that external user. External
integrations should present the newest returned `linkUrl` to the user.

## Browser Handoff

When the user opens `linkUrl`, the browser lands on the management console route
`/integrations/external-chat/link?token=<external-chat-link-token>`. The console
shows the normal login page when no browser session exists, preserving the token
while the user chooses password or OIDC sign-in.

After an existing session, password sign-in, or OIDC sign-in establishes a
browser session, the management console shows an AcornOps approval screen that
tells the user they are linking the signed-in account to the external integration. The durable
link is completed only after the user clicks approve:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/chat/integration/link/complete
```

Request:

```json
{
  "token": "intlink_..."
}
```

Successful completion response:

```json
{
  "status": "linked"
}
```

## Resolve Link

Resolves whether an external user id is durably linked to an AcornOps user.

Request:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/chat/integration/resolve
Authorization: Bearer {EXTERNAL_INTEGRATION_SERVICE_TOKEN}
Content-Type: application/json
```

Body:

```json
{
  "externalUserId": "external-user-id"
}
```

Linked response:

```json
{
  "status": "linked",
  "user": {
    "id": "acornops-user-id",
    "email": "user@example.com",
    "displayName": "User Name"
  },
  "link": {
    "linkedAt": "2026-06-09T00:00:00.000Z",
    "lastAuthenticatedAt": "2026-06-09T00:00:00.000Z",
    "expiresAt": "2026-07-09T00:00:00.000Z"
  }
}
```

The linked response always includes `linkedAt`, `lastAuthenticatedAt`, and
`expiresAt`.

Unlinked response:

```json
{
  "status": "unlinked"
}
```

## Security Rules

- AcornOps accepts only the `externalUserId` value supplied to the link or
  resolve endpoint. It does not accept AcornOps user ids from the integration
  client.
- Browser cookies, OIDC access tokens, ID tokens, refresh tokens, and raw link
  tokens are never returned to external integration clients.
- Link tokens are stored only as hashes and are consumed when linking succeeds.
- Superseded link tokens are invalidated and must not complete account linking.
- This contract is scoped to a single external integration client where external user
  ids are unique across teams.
