import { createHash } from 'node:crypto';

import { db } from '../infra/db.js';
import { withCurrentWorkspaceMemberMcpGenerationLockInTransaction } from './repository-mcp-user-lifecycle.js';
import { withTransaction } from './repository-transaction.js';

export interface McpOAuthStateCorrelation {
  workspaceId: string;
  userId: string;
  serverId: string;
  returnPath: string;
  membershipGeneration: number;
}

interface McpOAuthStateCorrelationRow {
  workspace_id: string;
  user_id: string;
  server_id: string;
  return_path: string;
  membership_generation: number | string;
}

function stateHash(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

export async function recordMcpOAuthPreparationCorrelation(input: {
  preparationHandle: string;
  workspaceId: string;
  userId: string;
  serverId: string;
  returnPath: string;
  membershipGeneration: number;
}): Promise<void> {
  const result = await db.query(
    `INSERT INTO mcp_oauth_preparation_correlations (
       preparation_handle_hash,workspace_id,user_id,server_id,return_path,
       membership_generation,expires_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '30 minutes')
     ON CONFLICT (preparation_handle_hash) DO NOTHING`,
    [
      stateHash(input.preparationHandle),
      input.workspaceId,
      input.userId,
      input.serverId,
      input.returnPath,
      input.membershipGeneration
    ]
  );
  if (result.rowCount !== 1) throw new Error('MCP OAuth preparation correlation already exists');
}

export async function getMcpOAuthPreparationCorrelation(input: {
  preparationHandle: string;
  workspaceId: string;
  userId: string;
  serverId: string;
  membershipGeneration: number;
}): Promise<McpOAuthStateCorrelation | null> {
  const result = await db.query<McpOAuthStateCorrelationRow>(
    `SELECT workspace_id,user_id,server_id,return_path,membership_generation
     FROM mcp_oauth_preparation_correlations
     WHERE preparation_handle_hash=$1 AND workspace_id=$2 AND user_id=$3
       AND server_id=$4 AND membership_generation=$5 AND expires_at>NOW()`,
    [
      stateHash(input.preparationHandle),
      input.workspaceId,
      input.userId,
      input.serverId,
      input.membershipGeneration
    ]
  );
  if (!result.rowCount) return null;
  return mapCorrelation(result.rows[0]);
}

export async function deleteMcpOAuthPreparationCorrelation(preparationHandle: string): Promise<void> {
  await db.query(
    'DELETE FROM mcp_oauth_preparation_correlations WHERE preparation_handle_hash=$1',
    [stateHash(preparationHandle)]
  );
}

function mapCorrelation(row: McpOAuthStateCorrelationRow): McpOAuthStateCorrelation {
  const membershipGeneration = Number(row.membership_generation);
  if (!Number.isSafeInteger(membershipGeneration) || membershipGeneration <= 0) {
    throw new Error('MCP OAuth membership generation is outside the safe integer range');
  }
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    serverId: row.server_id,
    returnPath: row.return_path,
    membershipGeneration
  };
}

export async function recordMcpOAuthStateCorrelation(input: {
  state: string;
  workspaceId: string;
  userId: string;
  serverId: string;
  returnPath: string;
  membershipGeneration: number;
}): Promise<void> {
  const result = await db.query(
    `INSERT INTO mcp_oauth_state_correlations (
       state_hash,workspace_id,user_id,server_id,return_path,membership_generation,expires_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '30 minutes')
     ON CONFLICT (state_hash) DO NOTHING`,
    [
      stateHash(input.state),
      input.workspaceId,
      input.userId,
      input.serverId,
      input.returnPath,
      input.membershipGeneration
    ]
  );
  if (result.rowCount !== 1) throw new Error('MCP OAuth state correlation already exists');
}

export async function getMcpOAuthStateCorrelation(
  state: string,
  userId: string
): Promise<McpOAuthStateCorrelation | null> {
  const result = await db.query<McpOAuthStateCorrelationRow>(
    `SELECT workspace_id,user_id,server_id,return_path,membership_generation
     FROM mcp_oauth_state_correlations
     WHERE state_hash=$1 AND user_id=$2 AND expires_at>NOW()`,
    [stateHash(state), userId]
  );
  if (!result.rowCount) return null;
  return mapCorrelation(result.rows[0]);
}

export type McpOAuthStateAdmission =
  | { status: 'missing' }
  | { status: 'stale'; correlation: McpOAuthStateCorrelation }
  | { status: 'consumed'; correlation: McpOAuthStateCorrelation };

/**
 * Admits a callback under short local locks and consumes its state before all
 * remote token exchange. Remote I/O must happen only after this transaction.
 */
export async function consumeCurrentMcpOAuthStateCorrelation(
  state: string,
  userId: string
): Promise<McpOAuthStateAdmission> {
  return withTransaction(async (client) => {
    const result = await client.query<McpOAuthStateCorrelationRow>(
      `SELECT workspace_id,user_id,server_id,return_path,membership_generation
       FROM mcp_oauth_state_correlations
       WHERE state_hash=$1 AND user_id=$2 AND expires_at>NOW()`,
      [stateHash(state), userId]
    );
    if (!result.rowCount) return { status: 'missing' };
    const correlation = mapCorrelation(result.rows[0]);
    const admission = await withCurrentWorkspaceMemberMcpGenerationLockInTransaction(
      client,
      correlation.workspaceId,
      userId,
      correlation.membershipGeneration,
      async () => client.query(
        `DELETE FROM mcp_oauth_state_correlations
         WHERE state_hash=$1 AND workspace_id=$2 AND user_id=$3 AND membership_generation=$4`,
        [stateHash(state), correlation.workspaceId, userId, correlation.membershipGeneration]
      )
    );
    if (!admission.current) {
      await client.query(
        `DELETE FROM mcp_oauth_state_correlations
         WHERE state_hash=$1 AND workspace_id=$2 AND user_id=$3 AND membership_generation=$4`,
        [stateHash(state), correlation.workspaceId, userId, correlation.membershipGeneration]
      );
      return { status: 'stale', correlation };
    }
    return admission.value.rowCount === 1
      ? { status: 'consumed', correlation }
      : { status: 'missing' };
  });
}

export async function deleteMcpOAuthStateCorrelation(state: string): Promise<void> {
  await db.query('DELETE FROM mcp_oauth_state_correlations WHERE state_hash=$1', [stateHash(state)]);
}

export async function deleteExpiredMcpOAuthCorrelations(limit = 100): Promise<void> {
  await db.query(
    `DELETE FROM mcp_oauth_state_correlations
     WHERE state_hash IN (
       SELECT state_hash FROM mcp_oauth_state_correlations
       WHERE expires_at<=NOW() ORDER BY expires_at,state_hash LIMIT $1
     )`,
    [limit]
  );
  await db.query(
    `DELETE FROM mcp_oauth_preparation_correlations
     WHERE preparation_handle_hash IN (
       SELECT preparation_handle_hash FROM mcp_oauth_preparation_correlations
       WHERE expires_at<=NOW() ORDER BY expires_at,preparation_handle_hash LIMIT $1
     )`,
    [limit]
  );
}
