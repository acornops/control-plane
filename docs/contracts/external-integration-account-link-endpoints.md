# External integration account link endpoints

This document defines the AcornOps-owned HTTP contract for external integration
account linking. External integration client-side command handling, message
rendering, event handling, and retry behavior belong outside AcornOps.

## Integration configuration

External integration clients call the control-plane API with:

- `ACORNOPS_API_BASE_URL`, for example `https://api.acornops.dev`.
- A raw external integration client token issued out of band by the operator.
- An external user id supplied as `externalUserId`.

The control plane receives registered clients from `EXTERNAL_INTEGRATION_CLIENTS_JSON`.
The JSON contains installed-client descriptors with `id`, `provider`,
`displayName`, `sha256`, optional `enabled`, and optional
`allowedCapabilities`. Store only SHA-256 token hashes in the descriptor. Do not
store raw client tokens in config, docs, logs, or API responses.

`allowedCapabilities` is an operator-managed maximum for the registered client.
If omitted, the client can request the default external integration ceiling:
`read_workspace_data`, `create_sessions`, and `create_read_only_runs`. It does
not grant workspace access by itself; users still approve per-workspace grants.
Operators may add `create_read_write_runs` when the client may request
write-capable troubleshooting runs. Keep `read_workspace_data` and
`create_sessions` in that descriptor because run creation depends on them.
Approval decisions remain browser-user-session only.

The installed client id is the identity boundary. AcornOps scopes durable links
by `(integrationClientId, provider, externalUserId)`.

## Create link

Creates a short-lived AcornOps link for an external user id.

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/external-integrations/link
Authorization: Bearer {external-integration-client-token}
Content-Type: application/json
```

```json
{
  "externalUserId": "external-user-id",
  "externalDisplayName": "User Name"
}
```

Successful response:

```json
{
  "linkUrl": "https://console.acornops.dev/integrations/external/link?token=intlink_...",
  "expiresAt": "2026-06-09T00:00:00.000Z"
}
```

Creating a new link for the same scoped identity supersedes only previous
unconsumed, unexpired link tokens for that same client/provider/user tuple.

## Browser handoff

When the user opens `linkUrl`, the browser lands on the management console route
`/integrations/external/link?token=<external-integration-link-token>`. The console
shows the normal login page when no browser session exists, preserving the token
while the user chooses password or OIDC sign-in.

After an existing session, password sign-in, or OIDC sign-in establishes a
browser session, the management console previews safe consent metadata:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/external-integrations/link/preview
```

```json
{
  "token": "intlink_..."
}
```

The preview response returns provider, registered client display name, external
account metadata, expiry, the signed-in AcornOps user, and
`grantableWorkspaces[]`. Each grantable workspace includes the workspace id,
name, signed-in user's role, current `grantedCapabilities`, and
`grantableCapabilities`.

The durable link is completed only after the user clicks approve:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/external-integrations/link/complete
```

```json
{
  "token": "intlink_...",
  "workspaceGrants": [
    {
      "workspaceId": "workspace-id",
      "capabilities": ["read_workspace_data"]
    }
  ]
}
```

Successful completion response:

```json
{
  "status": "linked"
}
```

## Resolve link

Resolves whether the authenticated integration client has linked an external user
id to an AcornOps user.

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/external-integrations/resolve
Authorization: Bearer {external-integration-client-token}
Content-Type: application/json
```

```json
{
  "externalUserId": "external-user-id"
}
```

Linked responses include `integrationClientId`, `provider`, `clientDisplayName`,
`externalUserId`, `linkedAt`, `lastAuthenticatedAt`, and `expiresAt`. Unlinked
responses return `{ "status": "unlinked" }`.

## Revoke and unlink

Integration clients can revoke their own scoped links:

```http
POST {ACORNOPS_API_BASE_URL}/api/v1/auth/external-integrations/revoke
Authorization: Bearer {external-integration-client-token}
Content-Type: application/json
```

```json
{
  "externalUserId": "external-user-id"
}
```

Signed-in users can list and unlink their own active links with:

- `GET /api/v1/auth/external-integrations/links`
- `PATCH /api/v1/auth/external-integrations/links/{linkId}/grants`
- `POST /api/v1/auth/external-integrations/links/unlink`

Revocation sets `revoked_at`; durable rows are not deleted.

Grant replacement accepts:

```json
{
  "workspaceGrants": [
    {
      "workspaceId": "workspace-id",
      "capabilities": ["read_workspace_data", "create_sessions", "create_read_only_runs"]
    }
  ]
}
```

Missing grant rows mean the external integration has no access to that
workspace. Effective permissions are always computed as the linked user's
workspace role intersected with the registered client's allowed capabilities and
the user-approved workspace grant.

## Security rules

- AcornOps derives `integrationClientId` and `provider` only from the bearer token.
- Link and resolve bodies must not accept client identity fields.
- Browser cookies, OIDC access tokens, ID tokens, refresh tokens, raw client
  tokens, and raw link tokens are never returned to external integration clients.
- Link tokens are stored only as hashes and are consumed when linking succeeds.
- Superseded link tokens are invalidated and must not complete account linking.
