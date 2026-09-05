import type { PoolClient } from 'pg';

import { db } from '../infra/db.js';
import { withTransaction } from './repository-transaction.js';

export type WorkspaceMemberMcpLifecycleStatus = 'active' | 'removed';
export type WorkspaceMemberMcpReconciliationStatus = 'pending' | 'processing' | 'failed' | 'synced';

export interface WorkspaceMemberMcpLifecycle {
  workspaceId: string;
  userId: string;
  membershipGeneration: number;
  status: WorkspaceMemberMcpLifecycleStatus;
  reconciliationStatus: WorkspaceMemberMcpReconciliationStatus;
}

interface WorkspaceMemberMcpLifecycleRow {
  workspace_id: string;
  user_id: string;
  membership_generation: number | string;
  status: WorkspaceMemberMcpLifecycleStatus;
  reconciliation_status: WorkspaceMemberMcpReconciliationStatus;
}

function mapLifecycle(row: WorkspaceMemberMcpLifecycleRow): WorkspaceMemberMcpLifecycle {
  const membershipGeneration = Number(row.membership_generation);
  if (!Number.isSafeInteger(membershipGeneration) || membershipGeneration <= 0) {
    throw new Error('Workspace MCP membership generation is outside the safe integer range');
  }
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    membershipGeneration,
    status: row.status,
    reconciliationStatus: row.reconciliation_status
  };
}

export async function readWorkspaceMemberMcpLifecycleInTransaction(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  expectedStatus: WorkspaceMemberMcpLifecycleStatus
): Promise<WorkspaceMemberMcpLifecycle> {
  const result = await client.query<WorkspaceMemberMcpLifecycleRow>(
    `SELECT workspace_id,user_id,membership_generation,status,reconciliation_status
     FROM workspace_member_mcp_lifecycle
     WHERE workspace_id=$1 AND user_id=$2
     FOR UPDATE`,
    [workspaceId, userId]
  );
  if (!result.rowCount || result.rows[0].status !== expectedStatus) {
    throw new Error(`Workspace MCP membership lifecycle did not transition to ${expectedStatus}`);
  }
  return mapLifecycle(result.rows[0]);
}

export async function getWorkspaceMemberMcpLifecycle(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberMcpLifecycle | null> {
  const result = await db.query<WorkspaceMemberMcpLifecycleRow>(
    `SELECT lifecycle.workspace_id,lifecycle.user_id,lifecycle.membership_generation,
            lifecycle.status,lifecycle.reconciliation_status
     FROM workspace_member_mcp_lifecycle lifecycle
     WHERE lifecycle.workspace_id=$1 AND lifecycle.user_id=$2`,
    [workspaceId, userId]
  );
  return result.rowCount ? mapLifecycle(result.rows[0]) : null;
}

export async function getActiveWorkspaceMemberMcpGeneration(
  workspaceId: string,
  userId: string
): Promise<number | null> {
  const result = await db.query<{ membership_generation: number | string }>(
    `SELECT lifecycle.membership_generation
     FROM workspace_member_mcp_lifecycle lifecycle
     INNER JOIN workspace_memberships membership
       ON membership.workspace_id=lifecycle.workspace_id AND membership.user_id=lifecycle.user_id
     WHERE lifecycle.workspace_id=$1 AND lifecycle.user_id=$2
       AND lifecycle.status='active' AND lifecycle.reconciliation_status='synced'`,
    [workspaceId, userId]
  );
  if (!result.rowCount) return null;
  const membershipGeneration = Number(result.rows[0].membership_generation);
  if (!Number.isSafeInteger(membershipGeneration) || membershipGeneration <= 0) {
    throw new Error('Workspace MCP membership generation is outside the safe integer range');
  }
  return membershipGeneration;
}

/**
 * Runs work only while the pinned user generation is still the exact active,
 * reconciled workspace membership generation. Membership is locked before the
 * lifecycle row to match the DELETE -> lifecycle-trigger lock order.
 */
export async function withCurrentWorkspaceMemberMcpGenerationLock<T>(
  workspaceId: string,
  userId: string,
  expectedGeneration: number,
  work: () => Promise<T>
): Promise<{ current: true; value: T } | { current: false }> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0) {
    return { current: false };
  }
  return withTransaction((client) => withCurrentWorkspaceMemberMcpGenerationLockInTransaction(
    client,
    workspaceId,
    userId,
    expectedGeneration,
    work
  ));
}

export async function withCurrentWorkspaceMemberMcpGenerationLockInTransaction<T>(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  expectedGeneration: number,
  work: () => Promise<T>
): Promise<{ current: true; value: T } | { current: false }> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0) {
    return { current: false };
  }
  const membership = await client.query(
    `SELECT membership.workspace_id
     FROM workspace_memberships membership
     WHERE membership.workspace_id=$1 AND membership.user_id=$2
     FOR SHARE OF membership`,
    [workspaceId, userId]
  );
  if (!membership.rowCount) return { current: false };

  const lifecycle = await client.query<WorkspaceMemberMcpLifecycleRow>(
    `SELECT lifecycle.workspace_id,lifecycle.user_id,lifecycle.membership_generation,
            lifecycle.status,lifecycle.reconciliation_status
     FROM workspace_member_mcp_lifecycle lifecycle
     WHERE lifecycle.workspace_id=$1 AND lifecycle.user_id=$2
     FOR SHARE OF lifecycle`,
    [workspaceId, userId]
  );
  if (!lifecycle.rowCount) return { current: false };
  const current = mapLifecycle(lifecycle.rows[0]);
  if (
    current.status !== 'active'
    || current.reconciliationStatus !== 'synced'
    || current.membershipGeneration !== expectedGeneration
  ) {
    return { current: false };
  }
  return { current: true, value: await work() };
}

export async function getMcpUserLifecycleReconciliationBacklog(): Promise<{
  pending: number;
  processing: number;
  failed: number;
}> {
  const result = await db.query<{ reconciliation_status: string; count: number | string }>(
    `SELECT reconciliation_status,COUNT(*)::bigint AS count
     FROM workspace_member_mcp_lifecycle
     WHERE reconciliation_status<>'synced'
     GROUP BY reconciliation_status`
  );
  const counts = { pending: 0, processing: 0, failed: 0 };
  for (const row of result.rows) {
    if (row.reconciliation_status in counts) {
      counts[row.reconciliation_status as keyof typeof counts] = Number(row.count);
    }
  }
  return counts;
}

export async function countMcpUserLifecycleReadinessBlockers(): Promise<number> {
  const result = await db.query<{ count: number | string }>(
    `SELECT COUNT(*)::bigint AS count
     FROM workspace_member_mcp_lifecycle
     WHERE blocks_readiness=true AND reconciliation_status<>'synced'`
  );
  return Number(result.rows[0]?.count || 0);
}
