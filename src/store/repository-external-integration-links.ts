import { randomUUID } from 'node:crypto';
import type { WorkspaceCapability } from '../auth/authorization.js';
import { db } from '../infra/db.js';
import type { Role, User } from '../types/domain.js';
import { toIso, type UserRow } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

interface ExternalIntegrationLinkTokenRow {
  id: string;
  token_hash: string;
  integration_client_id: string;
  provider: string;
  client_display_name: string;
  external_user_id: string;
  external_display_name: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  invalidated_at: Date | string | null;
}

interface ExternalIntegrationUserLinkRow {
  id: string;
  integration_client_id: string;
  provider: string;
  client_display_name: string;
  external_user_id: string;
  external_display_name: string | null;
  acornops_user_id: string;
  linked_at: Date | string;
  last_authenticated_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  user_id?: string;
  email?: string;
  display_name?: string;
  created_at?: Date | string;
}

interface ExternalIntegrationWorkspaceGrantRow {
  id: string;
  external_integration_user_link_id: string;
  workspace_id: string;
  capabilities: WorkspaceCapability[];
  granted_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  workspace_name?: string;
  role?: Role;
}

export interface ExternalIntegrationClientIdentity {
  integrationClientId: string;
  provider: string;
}

export interface ExternalIntegrationClientMetadata extends ExternalIntegrationClientIdentity {
  clientDisplayName: string;
}

export interface ExternalIntegrationIdentityLookup extends ExternalIntegrationClientIdentity {
  externalUserId: string;
}

export interface CreateExternalIntegrationLinkTokenInput extends ExternalIntegrationClientMetadata {
  tokenHash: string;
  externalUserId: string;
  externalDisplayName?: string;
  expiresAt: Date;
}

export interface ExternalIntegrationLinkResolution {
  status: 'linked';
  user: Pick<User, 'id' | 'email' | 'displayName'>;
  link: {
    id: string;
    integrationClientId: string;
    provider: string;
    clientDisplayName: string;
    externalUserId: string;
    externalDisplayName?: string;
    linkedAt: string;
    lastAuthenticatedAt: string;
    expiresAt: string;
  };
}

export interface ExternalIntegrationLinkPreview {
  integrationClientId: string;
  provider: string;
  clientDisplayName: string;
  externalUserId: string;
  externalDisplayName?: string;
  expiresAt: string;
}

export interface ExternalIntegrationUserLinkSummary {
  id: string;
  integrationClientId: string;
  provider: string;
  clientDisplayName: string;
  externalUserId: string;
  externalDisplayName?: string;
  linkedAt: string;
  lastAuthenticatedAt: string;
  expiresAt: string;
  grants: ExternalIntegrationWorkspaceGrantSummary[];
}

export interface ExternalIntegrationWorkspaceGrantSummary {
  workspaceId: string;
  capabilities: WorkspaceCapability[];
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalIntegrationGrantableWorkspace {
  workspaceId: string;
  workspaceName: string;
  role: Role;
  grantedCapabilities: WorkspaceCapability[];
}

export interface ExternalIntegrationWorkspaceGrantInput {
  workspaceId: string;
  capabilities: WorkspaceCapability[];
}

export interface RevokeExternalIntegrationLinkResult {
  status: 'revoked' | 'unavailable';
  link?: ExternalIntegrationUserLinkSummary;
}

export async function externalIntegrationLinkTokenIsPending(tokenHash: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM external_integration_link_tokens
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND invalidated_at IS NULL
         AND expires_at > NOW()
     ) AS exists`,
    [tokenHash]
  );
  return Boolean(result.rows[0]?.exists);
}

function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: toIso(row.created_at)!
  };
}

function advisoryIdentity(input: ExternalIntegrationIdentityLookup): string {
  return `${input.integrationClientId}:${input.provider}:${input.externalUserId}`;
}

function summaryFromRow(row: ExternalIntegrationUserLinkRow): ExternalIntegrationUserLinkSummary {
  return {
    id: row.id,
    integrationClientId: row.integration_client_id,
    provider: row.provider,
    clientDisplayName: row.client_display_name,
    externalUserId: row.external_user_id,
    ...(row.external_display_name ? { externalDisplayName: row.external_display_name } : {}),
    linkedAt: toIso(row.linked_at)!,
    lastAuthenticatedAt: toIso(row.last_authenticated_at)!,
    expiresAt: toIso(row.expires_at)!,
    grants: []
  };
}

function grantSummaryFromRow(row: ExternalIntegrationWorkspaceGrantRow): ExternalIntegrationWorkspaceGrantSummary {
  return {
    workspaceId: row.workspace_id,
    capabilities: row.capabilities || [],
    grantedByUserId: row.granted_by_user_id,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export async function createExternalIntegrationLinkToken(input: CreateExternalIntegrationLinkTokenInput): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [advisoryIdentity(input)]);
    await client.query(
      `UPDATE external_integration_link_tokens
       SET invalidated_at = NOW()
       WHERE integration_client_id = $1
         AND provider = $2
         AND external_user_id = $3
         AND consumed_at IS NULL
         AND invalidated_at IS NULL
         AND expires_at > NOW()`,
      [input.integrationClientId, input.provider, input.externalUserId]
    );
    await client.query(
      `INSERT INTO external_integration_link_tokens (
         id, token_hash, integration_client_id, provider, client_display_name,
         external_user_id, external_display_name, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        input.tokenHash,
        input.integrationClientId,
        input.provider,
        input.clientDisplayName,
        input.externalUserId,
        input.externalDisplayName || null,
        input.expiresAt
      ]
    );
  });
}

export async function previewExternalIntegrationLinkToken(tokenHash: string): Promise<ExternalIntegrationLinkPreview | null> {
  const result = await db.query<ExternalIntegrationLinkTokenRow>(
    `SELECT *
     FROM external_integration_link_tokens
     WHERE token_hash = $1
       AND consumed_at IS NULL
       AND invalidated_at IS NULL
       AND expires_at > NOW()`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    integrationClientId: row.integration_client_id,
    provider: row.provider,
    clientDisplayName: row.client_display_name,
    externalUserId: row.external_user_id,
    ...(row.external_display_name ? { externalDisplayName: row.external_display_name } : {}),
    expiresAt: toIso(row.expires_at)!
  };
}

export async function getExternalIntegrationLinkTokenUser(tokenHash: string): Promise<User | null> {
  const result = await db.query<UserRow>(
    `SELECT u.*
     FROM external_integration_link_tokens t
     JOIN external_integration_user_links l
       ON l.integration_client_id = t.integration_client_id
      AND l.provider = t.provider
      AND l.external_user_id = t.external_user_id
     JOIN users u ON u.id = l.acornops_user_id
     WHERE t.token_hash = $1
       AND t.consumed_at IS NOT NULL
       AND t.invalidated_at IS NULL
       AND l.revoked_at IS NULL
       AND l.expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

export async function completeExternalIntegrationLinkToken(input: {
  tokenHash: string;
  acornopsUserId: string;
  linkExpiresAt: Date;
}): Promise<ExternalIntegrationUserLinkSummary | null> {
  return withTransaction(async (client) => {
    const tokenResult = await client.query<ExternalIntegrationLinkTokenRow>(
      `SELECT *
       FROM external_integration_link_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [input.tokenHash]
    );
    const token = tokenResult.rows[0];
    if (!token || token.consumed_at || token.invalidated_at || new Date(token.expires_at).getTime() <= Date.now()) {
      return null;
    }

    const linkResult = await client.query<ExternalIntegrationUserLinkRow>(
      `INSERT INTO external_integration_user_links (
         id, integration_client_id, provider, client_display_name,
         external_user_id, external_display_name, acornops_user_id,
         linked_at, last_authenticated_at, expires_at, revoked_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8, NULL)
       ON CONFLICT (integration_client_id, provider, external_user_id)
       DO UPDATE SET
         client_display_name = EXCLUDED.client_display_name,
         external_display_name = EXCLUDED.external_display_name,
         acornops_user_id = EXCLUDED.acornops_user_id,
         last_authenticated_at = NOW(),
         expires_at = EXCLUDED.expires_at,
         revoked_at = NULL
       RETURNING *`,
      [
        randomUUID(),
        token.integration_client_id,
        token.provider,
        token.client_display_name,
        token.external_user_id,
        token.external_display_name,
        input.acornopsUserId,
        input.linkExpiresAt
      ]
    );
    await client.query('UPDATE external_integration_link_tokens SET consumed_at = NOW() WHERE token_hash = $1', [input.tokenHash]);
    return summaryFromRow(linkResult.rows[0]);
  });
}

export async function resolveExternalIntegrationUserLink(input: ExternalIntegrationIdentityLookup): Promise<ExternalIntegrationLinkResolution | null> {
  const result = await db.query<ExternalIntegrationUserLinkRow>(
    `SELECT l.*, u.id AS user_id, u.email, u.display_name, u.created_at
     FROM external_integration_user_links l
     JOIN users u ON l.acornops_user_id = u.id
     WHERE l.integration_client_id = $1
       AND l.provider = $2
       AND l.external_user_id = $3
       AND l.revoked_at IS NULL
       AND l.expires_at > NOW()`,
    [input.integrationClientId, input.provider, input.externalUserId]
  );
  const row = result.rows[0];
  if (!row || !row.user_id || !row.email || !row.display_name || !row.created_at) return null;
  return {
    status: 'linked',
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name
    },
    link: {
      id: row.id,
      integrationClientId: row.integration_client_id,
      provider: row.provider,
      clientDisplayName: row.client_display_name,
      externalUserId: row.external_user_id,
      ...(row.external_display_name ? { externalDisplayName: row.external_display_name } : {}),
      linkedAt: toIso(row.linked_at)!,
      lastAuthenticatedAt: toIso(row.last_authenticated_at)!,
      expiresAt: toIso(row.expires_at)!
    }
  };
}

export async function listExternalIntegrationUserLinks(acornopsUserId: string): Promise<ExternalIntegrationUserLinkSummary[]> {
  const result = await db.query<ExternalIntegrationUserLinkRow>(
    `SELECT *
     FROM external_integration_user_links
     WHERE acornops_user_id = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     ORDER BY provider ASC, client_display_name ASC, external_user_id ASC`,
    [acornopsUserId]
  );
  const links = result.rows.map(summaryFromRow);
  if (!links.length) return links;
  const grantResult = await db.query<ExternalIntegrationWorkspaceGrantRow>(
    `SELECT *
     FROM external_integration_workspace_grants
     WHERE external_integration_user_link_id = ANY($1::text[])
     ORDER BY workspace_id ASC`,
    [links.map((link) => link.id)]
  );
  const grantsByLinkId = new Map<string, ExternalIntegrationWorkspaceGrantSummary[]>();
  for (const row of grantResult.rows) {
    const current = grantsByLinkId.get(row.external_integration_user_link_id) || [];
    current.push(grantSummaryFromRow(row));
    grantsByLinkId.set(row.external_integration_user_link_id, current);
  }
  return links.map((link) => ({
    ...link,
    grants: grantsByLinkId.get(link.id) || []
  }));
}

export async function listExternalIntegrationGrantableWorkspaces(input: ExternalIntegrationIdentityLookup & {
  acornopsUserId: string;
}): Promise<ExternalIntegrationGrantableWorkspace[]> {
  const result = await db.query<ExternalIntegrationWorkspaceGrantRow>(
    `SELECT
       w.id AS workspace_id,
       w.name AS workspace_name,
       m.role,
       COALESCE(g.capabilities, ARRAY[]::text[]) AS capabilities
     FROM workspaces w
     JOIN workspace_memberships m
       ON m.workspace_id = w.id
      AND m.user_id = $4
     LEFT JOIN external_integration_user_links l
       ON l.integration_client_id = $1
      AND l.provider = $2
      AND l.external_user_id = $3
      AND l.acornops_user_id = $4
      AND l.revoked_at IS NULL
      AND l.expires_at > NOW()
     LEFT JOIN external_integration_workspace_grants g
       ON g.external_integration_user_link_id = l.id
      AND g.workspace_id = w.id
     ORDER BY w.name ASC, w.id ASC`,
    [input.integrationClientId, input.provider, input.externalUserId, input.acornopsUserId]
  );
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name || row.workspace_id,
    role: row.role!,
    grantedCapabilities: row.capabilities || []
  }));
}

export async function getExternalIntegrationWorkspaceGrant(input: {
  linkId: string;
  workspaceId: string;
}): Promise<ExternalIntegrationWorkspaceGrantSummary | null> {
  const result = await db.query<ExternalIntegrationWorkspaceGrantRow>(
    `SELECT *
     FROM external_integration_workspace_grants
     WHERE external_integration_user_link_id = $1
       AND workspace_id = $2
     LIMIT 1`,
    [input.linkId, input.workspaceId]
  );
  return result.rows[0] ? grantSummaryFromRow(result.rows[0]) : null;
}

export async function replaceExternalIntegrationWorkspaceGrants(input: {
  linkId: string;
  grantedByUserId: string;
  grants: ExternalIntegrationWorkspaceGrantInput[];
}): Promise<ExternalIntegrationWorkspaceGrantSummary[]> {
  return withTransaction(async (client) => {
    await client.query(
      'DELETE FROM external_integration_workspace_grants WHERE external_integration_user_link_id = $1',
      [input.linkId]
    );
    const summaries: ExternalIntegrationWorkspaceGrantSummary[] = [];
    for (const grant of input.grants) {
      const result = await client.query<ExternalIntegrationWorkspaceGrantRow>(
        `INSERT INTO external_integration_workspace_grants (
           id, external_integration_user_link_id, workspace_id, capabilities,
           granted_by_user_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING *`,
        [randomUUID(), input.linkId, grant.workspaceId, grant.capabilities, input.grantedByUserId]
      );
      summaries.push(grantSummaryFromRow(result.rows[0]));
    }
    return summaries;
  });
}

export async function revokeExternalIntegrationUserLink(input: ExternalIntegrationIdentityLookup & {
  acornopsUserId?: string;
}): Promise<RevokeExternalIntegrationLinkResult> {
  const clauses = [
    'integration_client_id = $1',
    'provider = $2',
    'external_user_id = $3',
    'revoked_at IS NULL',
    'expires_at > NOW()'
  ];
  const params: Array<string> = [input.integrationClientId, input.provider, input.externalUserId];
  if (input.acornopsUserId) {
    params.push(input.acornopsUserId);
    clauses.push(`acornops_user_id = $${params.length}`);
  }
  const result = await db.query<ExternalIntegrationUserLinkRow>(
    `UPDATE external_integration_user_links
     SET revoked_at = NOW()
     WHERE ${clauses.join(' AND ')}
     RETURNING *`,
    params
  );
  const row = result.rows[0];
  return row ? { status: 'revoked', link: summaryFromRow(row) } : { status: 'unavailable' };
}

export async function purgeOldExternalIntegrationLinkTokens(retentionDays: number, limit = 1000): Promise<number> {
  const safeRetentionDays = Math.max(1, Math.floor(Number.isFinite(retentionDays) ? retentionDays : 1));
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number.isFinite(limit) ? limit : 1000)));
  const result = await db.query(
    `WITH deleted AS (
       DELETE FROM external_integration_link_tokens
       WHERE id IN (
         SELECT id
         FROM external_integration_link_tokens
         WHERE expires_at < NOW() - ($1::int * INTERVAL '1 day')
            OR (
              (consumed_at IS NOT NULL OR invalidated_at IS NOT NULL)
              AND created_at < NOW() - ($1::int * INTERVAL '1 day')
            )
         ORDER BY created_at ASC, id ASC
         LIMIT $2
       )
       RETURNING 1
     )
     SELECT COUNT(*)::int AS deleted_count
     FROM deleted`,
    [safeRetentionDays, safeLimit]
  );
  return Number(result.rows[0]?.deleted_count ?? 0);
}
