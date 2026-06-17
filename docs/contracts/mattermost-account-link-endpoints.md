# Mattermost Account Link Endpoints

This document defines the AcornOps-owned HTTP contract for Mattermost account
linking. Mattermost-side command handling, message rendering, event handling,
and retry behavior belong outside AcornOps.

## Integration Configuration

External Mattermost integration clients call the control-plane API with:

- `ACORNOPS_API_BASE_URL`, for example `https://api.acornops.dev`.
- `MATTERMOST_CHAT_SERVICE_TOKEN`, matching the control-plane
  `MATTERMOST_CHAT_SERVICE_TOKEN`.
- A Mattermost user id supplied as `mattermostUserId`.

The integration token is valid only for the Mattermost account-link endpoints.
It is not a browser session, admin token, run token, or orchestrator service
token.

## Create Link

Creates a short-lived AcornOps link for a Mattermost user id.

Request:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/chat/mattermost/link
Authorization: Bearer {MATTERMOST_CHAT_SERVICE_TOKEN}
Content-Type: application/json
```

Body:

```json
{
  "mattermostUserId": "mattermost-user-id"
}
```

Successful response:

```json
{
  "linkUrl": "https://console.acornops.dev/integrations/mattermost/link?token=mmlink_...",
  "expiresAt": "2026-06-09T00:00:00.000Z"
}
```

AcornOps returns a management-console URL in `linkUrl`. External integrations
should treat the URL and embedded token as short-lived bearer secrets and avoid
logging them in normal logs.

Creating a new link for the same `mattermostUserId` supersedes any previous
unconsumed, unexpired link token for that Mattermost user. External
integrations should present the newest returned `linkUrl` to the user.

## Browser Handoff

When the user opens `linkUrl`, the browser lands on the management console route
`/integrations/mattermost/link?token=<mattermost-link-token>`. The console
shows the normal login page when no browser session exists, preserving the token
while the user chooses password or OIDC sign-in.

After an existing session, password sign-in, or OIDC sign-in establishes a
browser session, the management console completes the durable link with:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/chat/mattermost/link/complete
```

Request:

```json
{
  "token": "mmlink_..."
}
```

Successful completion response:

```json
{
  "status": "linked"
}
```

## Resolve Link

Resolves whether a Mattermost user id is durably linked to an AcornOps user.

Request:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/chat/mattermost/resolve
Authorization: Bearer {MATTERMOST_CHAT_SERVICE_TOKEN}
Content-Type: application/json
```

Body:

```json
{
  "mattermostUserId": "mattermost-user-id"
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

- AcornOps accepts only the `mattermostUserId` value supplied to the link or
  resolve endpoint. It does not accept AcornOps user ids from the integration
  client.
- Browser cookies, OIDC access tokens, ID tokens, refresh tokens, and raw link
  tokens are never returned to external integration clients.
- Link tokens are stored only as hashes and are consumed when linking succeeds.
- Superseded link tokens are invalidated and must not complete account linking.
- This contract is scoped to a single Mattermost server where Mattermost user
  ids are unique across teams.
