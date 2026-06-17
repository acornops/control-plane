import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import type { User } from '../types/domain.js';
import { toIso, type UserRow } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

interface ExternalIntegrationLinkTokenRow {
  id: string;
  token_hash: string;
  external_user_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  invalidated_at: Date | string | null;
}

interface ExternalIntegrationUserLinkRow {
  id: string;
  external_user_id: string;
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

export interface CreateExternalIntegrationLinkTokenInput {
  tokenHash: string;
  externalUserId: string;
  expiresAt: Date;
}

export interface ExternalIntegrationIdentityLookup {
  externalUserId: string;
}

export interface ExternalIntegrationLinkResolution {
  status: 'linked';
  user: Pick<User, 'id' | 'email' | 'displayName'>;
  link: {
    linkedAt: string;
    lastAuthenticatedAt: string;
    expiresAt: string;
  };
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

export async function createExternalIntegrationLinkToken(input: CreateExternalIntegrationLinkTokenInput): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.externalUserId]);
    await client.query(
      `UPDATE external_integration_link_tokens
       SET invalidated_at = NOW()
       WHERE external_user_id = $1
         AND consumed_at IS NULL
         AND invalidated_at IS NULL
         AND expires_at > NOW()`,
      [input.externalUserId]
    );
    await client.query(
      `INSERT INTO external_integration_link_tokens (
         id, token_hash, external_user_id, expires_at
       )
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), input.tokenHash, input.externalUserId, input.expiresAt]
    );
  });
}

export async function getExternalIntegrationLinkTokenUser(tokenHash: string): Promise<User | null> {
  const result = await db.query<UserRow>(
    `SELECT u.*
     FROM external_integration_link_tokens t
     JOIN external_integration_user_links l
       ON l.external_user_id = t.external_user_id
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
}): Promise<boolean> {
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
      return false;
    }

    await client.query(
      `INSERT INTO external_integration_user_links (
         id, external_user_id, acornops_user_id,
         linked_at, last_authenticated_at, expires_at, revoked_at
       )
       VALUES ($1, $2, $3, NOW(), NOW(), $4, NULL)
       ON CONFLICT (external_user_id)
       DO UPDATE SET
         acornops_user_id = EXCLUDED.acornops_user_id,
         last_authenticated_at = NOW(),
         expires_at = EXCLUDED.expires_at,
         revoked_at = NULL`,
      [
        randomUUID(),
        token.external_user_id,
        input.acornopsUserId,
        input.linkExpiresAt
      ]
    );
    await client.query('UPDATE external_integration_link_tokens SET consumed_at = NOW() WHERE token_hash = $1', [input.tokenHash]);
    return true;
  });
}

export async function resolveExternalIntegrationUserLink(input: ExternalIntegrationIdentityLookup): Promise<ExternalIntegrationLinkResolution | null> {
  const result = await db.query<ExternalIntegrationUserLinkRow>(
    `SELECT l.*, u.id AS user_id, u.email, u.display_name, u.created_at
     FROM external_integration_user_links l
     JOIN users u ON l.acornops_user_id = u.id
     WHERE l.acornops_user_id = u.id
       AND l.external_user_id = $1
       AND l.revoked_at IS NULL
       AND l.expires_at > NOW()`,
    [input.externalUserId]
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
      linkedAt: toIso(row.linked_at)!,
      lastAuthenticatedAt: toIso(row.last_authenticated_at)!,
      expiresAt: toIso(row.expires_at)!
    }
  };
}
