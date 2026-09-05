import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import type {
  WorkspaceMemberMcpLifecycleStatus,
  WorkspaceMemberMcpReconciliationStatus
} from '../store/repository-mcp-user-lifecycle.js';
import { getWorkspaceMemberMcpLifecycle } from '../store/repository-mcp-user-lifecycle.js';
import { withTransaction } from '../store/repository-transaction.js';
import {
  LlmGatewayHttpError,
  reconcileMcpUserLifecycle
} from './mcp-registry-client.js';

interface LifecycleReconciliationJob {
  workspace_id: string;
  user_id: string;
  membership_generation: number;
  status: WorkspaceMemberMcpLifecycleStatus;
  reconciliation_status: WorkspaceMemberMcpReconciliationStatus;
  attempt_count: number;
  lease_owner?: string;
}

const workerId = `${config.CONTROL_PLANE_INSTANCE_ID}:mcp-user-lifecycle:${randomUUID()}`;
const leaseSeconds = Math.ceil(config.LLM_GATEWAY_TIMEOUT_MS / 1000) + 30;

async function markSynced(job: LifecycleReconciliationJob): Promise<void> {
  const leasePredicate = job.lease_owner
    ? " AND reconciliation_status='processing' AND lease_owner=$5"
    : '';
  await db.query(
    `UPDATE workspace_member_mcp_lifecycle
     SET reconciliation_status='synced',attempt_count=0,next_attempt_at=NOW(),
         blocks_readiness=false,lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=NOW()
     WHERE workspace_id=$1 AND user_id=$2 AND membership_generation=$3 AND status=$4${leasePredicate}`,
    [
      job.workspace_id,
      job.user_id,
      job.membership_generation,
      job.status,
      ...(job.lease_owner ? [job.lease_owner] : [])
    ]
  );
}

async function markFailed(job: LifecycleReconciliationJob, errorCode: string): Promise<void> {
  const attempt = job.attempt_count + 1;
  const leasePredicate = job.lease_owner
    ? " AND reconciliation_status='processing' AND lease_owner=$8"
    : " AND reconciliation_status<>'synced'";
  await db.query(
    `UPDATE workspace_member_mcp_lifecycle
     SET reconciliation_status='failed',attempt_count=$5,
         next_attempt_at=NOW()+($6::text||' seconds')::interval,
         lease_owner=NULL,lease_expires_at=NULL,last_error_code=$7,updated_at=NOW()
     WHERE workspace_id=$1 AND user_id=$2 AND membership_generation=$3 AND status=$4${leasePredicate}`,
    [
      job.workspace_id,
      job.user_id,
      job.membership_generation,
      job.status,
      attempt,
      Math.min(3600, 2 ** Math.min(attempt, 11)),
      errorCode.slice(0, 64),
      ...(job.lease_owner ? [job.lease_owner] : [])
    ]
  );
}

async function claimedGenerationWasSuperseded(job: LifecycleReconciliationJob): Promise<boolean> {
  const result = await db.query<{ membership_generation: number | string }>(
    `SELECT membership_generation FROM workspace_member_mcp_lifecycle
     WHERE workspace_id=$1 AND user_id=$2`,
    [job.workspace_id, job.user_id]
  );
  if (!result.rowCount) return false;
  const currentGeneration = Number(result.rows[0].membership_generation);
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration <= 0) {
    throw new Error('Workspace MCP membership generation is outside the safe integer range');
  }
  return currentGeneration > job.membership_generation;
}

async function reconcile(
  job: LifecycleReconciliationJob,
  options: { rethrow: boolean }
): Promise<void> {
  try {
    await reconcileMcpUserLifecycle({
      workspaceId: job.workspace_id,
      userId: job.user_id,
      membershipGeneration: job.membership_generation,
      status: job.status
    });
    await markSynced(job);
  } catch (error) {
    if (
      error instanceof LlmGatewayHttpError
      && error.gatewayCode === 'MCP_USER_LIFECYCLE_STALE'
      && await claimedGenerationWasSuperseded(job)
    ) {
      return;
    }
    const errorCode = error instanceof LlmGatewayHttpError && error.gatewayCode
      ? error.gatewayCode
      : 'MCP_USER_LIFECYCLE_RECONCILIATION_FAILED';
    await markFailed(job, errorCode);
    logger.error({
      err: error,
      workspaceId: job.workspace_id,
      userId: job.user_id,
      membershipGeneration: job.membership_generation,
      lifecycleStatus: job.status,
      errorCode
    }, 'ALERT: MCP user lifecycle reconciliation failed and will retry');
    if (options.rethrow) throw error;
  }
}

export async function reconcileWorkspaceMemberMcpLifecycle(input: {
  workspaceId: string;
  userId: string;
  membershipGeneration: number;
  status: WorkspaceMemberMcpLifecycleStatus;
}): Promise<void> {
  await reconcile({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    membership_generation: input.membershipGeneration,
    status: input.status,
    reconciliation_status: 'pending',
    attempt_count: 0
  }, { rethrow: true });
}

export async function reconcileCurrentWorkspaceMemberMcpLifecycle(input: {
  workspaceId: string;
  userId: string;
  status: WorkspaceMemberMcpLifecycleStatus;
}): Promise<'reconciled' | 'already_synced' | null> {
  const lifecycle = await getWorkspaceMemberMcpLifecycle(input.workspaceId, input.userId);
  if (!lifecycle || lifecycle.status !== input.status) return null;
  if (lifecycle.reconciliationStatus === 'synced') return 'already_synced';
  await reconcileWorkspaceMemberMcpLifecycle({
    workspaceId: lifecycle.workspaceId,
    userId: lifecycle.userId,
    membershipGeneration: lifecycle.membershipGeneration,
    status: lifecycle.status
  });
  return 'reconciled';
}

async function claim(limit: number): Promise<LifecycleReconciliationJob[]> {
  return withTransaction(async (client) => {
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const result = await client.query<Omit<LifecycleReconciliationJob, 'membership_generation'> & {
      membership_generation: number | string;
    }>(
      `WITH candidates AS (
         SELECT DISTINCT ON (lifecycle.workspace_id)
                lifecycle.workspace_id,lifecycle.user_id,lifecycle.status,lifecycle.next_attempt_at
         FROM workspace_member_mcp_lifecycle lifecycle
         WHERE (
           (lifecycle.reconciliation_status IN ('pending','failed')
             AND lifecycle.next_attempt_at<=NOW()
             AND (lifecycle.lease_expires_at IS NULL OR lifecycle.lease_expires_at<NOW()))
           OR (lifecycle.reconciliation_status='processing' AND lifecycle.lease_expires_at<NOW())
         )
         AND NOT EXISTS (
           SELECT 1 FROM workspace_member_mcp_lifecycle in_flight
           WHERE in_flight.workspace_id=lifecycle.workspace_id
             AND in_flight.reconciliation_status='processing'
             AND in_flight.lease_expires_at>=NOW()
         )
         ORDER BY lifecycle.workspace_id,
                  CASE WHEN lifecycle.status='removed' THEN 0 ELSE 1 END,
                  lifecycle.next_attempt_at,lifecycle.user_id
       ), due AS (
         SELECT lifecycle.workspace_id,lifecycle.user_id
         FROM workspace_member_mcp_lifecycle lifecycle
         INNER JOIN candidates
           ON candidates.workspace_id=lifecycle.workspace_id
          AND candidates.user_id=lifecycle.user_id
         WHERE (
           (lifecycle.reconciliation_status IN ('pending','failed')
             AND lifecycle.next_attempt_at<=NOW()
             AND (lifecycle.lease_expires_at IS NULL OR lifecycle.lease_expires_at<NOW()))
           OR (lifecycle.reconciliation_status='processing' AND lifecycle.lease_expires_at<NOW())
         )
         ORDER BY CASE WHEN candidates.status='removed' THEN 0 ELSE 1 END,
                  candidates.next_attempt_at,candidates.workspace_id,candidates.user_id
         FOR UPDATE OF lifecycle SKIP LOCKED LIMIT $1
       )
       UPDATE workspace_member_mcp_lifecycle lifecycle
       SET reconciliation_status='processing',lease_owner=$2,
           lease_expires_at=NOW()+($3::text||' seconds')::interval,updated_at=NOW()
       FROM due
       WHERE lifecycle.workspace_id=due.workspace_id AND lifecycle.user_id=due.user_id
       RETURNING lifecycle.workspace_id,lifecycle.user_id,lifecycle.membership_generation,
                 lifecycle.status,lifecycle.reconciliation_status,lifecycle.attempt_count,
                 lifecycle.lease_owner`,
      [limit, leaseOwner, leaseSeconds]
    );
    return result.rows.map((row) => {
      const membershipGeneration = Number(row.membership_generation);
      if (!Number.isSafeInteger(membershipGeneration) || membershipGeneration <= 0) {
        throw new Error('Workspace MCP membership generation is outside the safe integer range');
      }
      return { ...row, membership_generation: membershipGeneration };
    });
  });
}

export async function runMcpUserLifecycleReconciliationTick(limit = 2): Promise<number> {
  const jobs = await claim(Math.min(2, Math.max(1, limit)));
  await Promise.all(jobs.map((job) => reconcile(job, { rethrow: false })));
  return jobs.length;
}
