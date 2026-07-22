import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementMcpSecretCleanup } from '../metrics.js';
import { cleanupMcpConnections } from './mcp-registry-client.js';
import { withTransaction } from '../store/repository-transaction.js';

type CleanupReason = 'member_removal' | 'workspace_delete';

type CleanupJob = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  reason: CleanupReason;
  attempt_count: number;
};

const workerId = `${config.CONTROL_PLANE_INSTANCE_ID}:mcp-cleanup:${randomUUID()}`;

export async function enqueueMcpSecretCleanup(input: {
  workspaceId: string;
  userId?: string;
  reason: CleanupReason;
}): Promise<void> {
  await db.query(
    `INSERT INTO mcp_secret_cleanup_jobs (id,workspace_id,user_id,reason)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), input.workspaceId, input.userId || null, input.reason]
  );
  incrementMcpSecretCleanup(input.reason, 'queued');
}

export async function cleanupRemovedMemberMcpConnections(
  workspaceId: string,
  userId: string
): Promise<void> {
  try {
    await cleanupMcpConnections(workspaceId, userId);
    incrementMcpSecretCleanup('member_removal', 'success');
  } catch {
    try {
      await enqueueMcpSecretCleanup({ workspaceId, userId, reason: 'member_removal' });
    } catch {
      incrementMcpSecretCleanup('member_removal', 'queue_failure');
      logger.error(
        { workspaceId, userId },
        'ALERT: membership revoked but MCP cleanup retry could not be persisted'
      );
    }
  }
}

async function claim(limit: number): Promise<CleanupJob[]> {
  return withTransaction(async (client) => {
    const result = await client.query<CleanupJob>(
      `WITH due AS (
         SELECT id FROM mcp_secret_cleanup_jobs
         WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
         ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE mcp_secret_cleanup_jobs job
       SET status='processing',lease_owner=$2,lease_expires_at=NOW()+INTERVAL '30 seconds',updated_at=NOW()
       FROM due WHERE job.id=due.id
       RETURNING job.id,job.workspace_id,job.user_id,job.reason,job.attempt_count`,
      [limit, workerId]
    );
    return result.rows;
  });
}

export async function runMcpSecretCleanupTick(limit = 25): Promise<void> {
  for (const job of await claim(limit)) {
    try {
      await cleanupMcpConnections(job.workspace_id, job.user_id || undefined);
      await db.query('DELETE FROM mcp_secret_cleanup_jobs WHERE id=$1', [job.id]);
      incrementMcpSecretCleanup(job.reason, 'success');
    } catch {
      const attempt = job.attempt_count + 1;
      await db.query(
        `UPDATE mcp_secret_cleanup_jobs SET status='failed',attempt_count=$2,
         next_attempt_at=NOW()+($3::text||' seconds')::interval,lease_owner=NULL,
         lease_expires_at=NULL,last_error_code='MCP_SECRET_CLEANUP_FAILED',updated_at=NOW()
         WHERE id=$1`,
        [job.id, attempt, Math.min(3600, 2 ** Math.min(attempt, 11))]
      );
      incrementMcpSecretCleanup(job.reason, 'failure');
      logger.error(
        { cleanupJobId: job.id, workspaceId: job.workspace_id, reason: job.reason, attempt },
        'ALERT: individual MCP credential cleanup failed and will retry'
      );
    }
  }
}
