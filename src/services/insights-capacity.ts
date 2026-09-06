import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { withTransaction } from '../store/repository-transaction.js';
import { acquireRunCapacity, assertCapacityOwner, lockReservation, lockActiveWorkspace, releaseRunCapacity, renewRunCapacity, reserveRunCapacity, settleRunCapacity, WorkspaceCapacityError } from '../store/repository-run-capacity.js';

export interface InsightsExecution {
  runId: string;
  ownerId: string;
  generation: number;
  workspaceId: string;
}

export async function withInsightsCapacity(job: { workspaceId: string; targetId: string; sessionId: string; leaseOwner: string; lastActivityAt: string },
  work: (execution: InsightsExecution) => Promise<void>): Promise<void> {
  let runId: string | undefined;
  let generation = 0;
  let waiting = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    if (!config.WORKSPACE_DISPATCH_ENABLED) {
      await withTransaction(async (client) => {
        await lockActiveWorkspace(client, job.workspaceId);
        await client.query(`UPDATE target_insights_checkpoint_jobs SET status='queued',due_at=clock_timestamp()+INTERVAL '10 seconds',lease_owner=NULL,lease_expires_at=NULL
          WHERE workspace_id=$1 AND target_id=$2 AND session_id=$3 AND lease_owner=$4`, [job.workspaceId, job.targetId, job.sessionId, job.leaseOwner]);
      });
      return;
    }
    runId = await withTransaction(async (client) => {
      await lockActiveWorkspace(client, job.workspaceId);
      const row = await client.query<{ capacity_run_id: string | null }>(
        `SELECT capacity_run_id FROM target_insights_checkpoint_jobs WHERE workspace_id=$1 AND target_id=$2 AND session_id=$3
         AND lease_owner=$4 AND last_activity_at=$5 FOR UPDATE`, [job.workspaceId, job.targetId, job.sessionId, job.leaseOwner, job.lastActivityAt]);
      if (!row.rowCount) throw new WorkspaceCapacityError('INSIGHTS_ATTEMPT_STALE', 'Insights attempt was superseded');
      const id = row.rows[0].capacity_run_id || randomUUID();
      await reserveRunCapacity(client, { workspaceId: job.workspaceId, runId: id, pool: 'insights' });
      await client.query('UPDATE target_insights_checkpoint_jobs SET capacity_run_id=$4 WHERE workspace_id=$1 AND target_id=$2 AND session_id=$3', [job.workspaceId, job.targetId, job.sessionId, id]);
      return id;
    });
    if (config.WORKSPACE_CAPACITY_ENABLED) {
      const grant = await acquireRunCapacity(runId, job.leaseOwner);
      if (grant.status === 'wait') {
        waiting = true;
        await db.query(`UPDATE target_insights_checkpoint_jobs SET status='queued',due_at=NOW()+INTERVAL '10 seconds',lease_owner=NULL,lease_expires_at=NULL
          WHERE workspace_id=$1 AND target_id=$2 AND session_id=$3 AND lease_owner=$4`, [job.workspaceId, job.targetId, job.sessionId, job.leaseOwner]);
        return;
      }
      if (grant.status !== 'granted') throw new WorkspaceCapacityError('EXECUTION_AUTHORITY_LOST', 'Insights execution authority unavailable');
      generation = grant.generation!;
      timer = setInterval(() => { void renewRunCapacity(runId!, job.leaseOwner, generation).catch(() => undefined); }, 10000);
      timer.unref();
    }
    await work({ runId, ownerId: job.leaseOwner, generation, workspaceId: job.workspaceId });
  } catch (error) {
    if (!(error instanceof WorkspaceCapacityError)) throw error;
    await db.query(`UPDATE target_insights_checkpoint_jobs SET status='skipped',last_error=$5,lease_owner=NULL,lease_expires_at=NULL
      WHERE workspace_id=$1 AND target_id=$2 AND session_id=$3 AND lease_owner=$4`, [job.workspaceId, job.targetId, job.sessionId, job.leaseOwner, error.code]);
  } finally {
    if (timer) clearInterval(timer);
    if (runId && !waiting) {
      if (generation) await releaseRunCapacity(runId, job.leaseOwner, generation);
      await settleRunCapacity(runId);
      await db.query(`UPDATE target_insights_checkpoint_jobs SET capacity_run_id=NULL
        WHERE workspace_id=$1 AND target_id=$2 AND session_id=$3 AND capacity_run_id=$4`, [job.workspaceId, job.targetId, job.sessionId, runId]);
    }
  }
}

/** Validate again under the workspace lock before persisting model output. */
export async function assertInsightsExecution(execution: InsightsExecution, transaction?: PoolClient): Promise<void> {
  const check = async (client: PoolClient) => {
    const row = await lockReservation(client, execution.runId);
    await lockActiveWorkspace(client, execution.workspaceId);
    if (config.WORKSPACE_CAPACITY_ENABLED) await assertCapacityOwner(client, row, execution.ownerId, execution.generation);
    const current = await client.query(`SELECT 1 FROM target_insights_checkpoint_jobs
      WHERE capacity_run_id=$1 AND workspace_id=$2 AND lease_owner=$3
        AND status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [execution.runId, execution.workspaceId, execution.ownerId]);
    if (!current.rowCount) throw new WorkspaceCapacityError('INSIGHTS_ATTEMPT_STALE', 'Insights attempt was superseded');
    const cancelled = await client.query(`SELECT 1 FROM workspace_lifecycle_outbox o JOIN workspace_run_reservations r
      ON r.workspace_id=o.workspace_id WHERE r.run_id=$1 AND o.requested_at>=r.created_at`, [execution.runId]);
    if (cancelled.rowCount) throw new WorkspaceCapacityError('RUN_CANCELLED_BY_SUSPENSION', 'Insights attempt was cancelled');
  };
  if (transaction) await check(transaction);
  else await withTransaction(check);
}
