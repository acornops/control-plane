import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementAutomationDispatch, observeAutomationDispatchDurationMs } from '../metrics.js';
import {
  getWorkflowRun,
  updateWorkflowRun,
  updateWorkflowRunIfStatus
} from '../store/repository-workflows.js';
import { recomputeWorkflowExecutionStatusForRun } from '../store/repository-automation-approvals.js';
import { withTransaction } from '../store/repository-transaction.js';
import {
  cancelRunInExecutionEngine,
  dispatchWorkflowRunToExecutionEngine
} from './execution-engine-client.js';

type OutboxRow = {
  id: string;
  workspace_id: string;
  source_type: 'workflow' | 'target';
  source_id: string;
  run_id: string;
  idempotency_key: string;
  attempt_count: number;
};

const workerId = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;
const canaryWorkspaceIds = new Set(
  config.AUTOMATION_CANARY_WORKSPACE_IDS.split(',').map((value) => value.trim()).filter(Boolean)
);

function workspaceEnabled(workspaceId: string): boolean {
  if (config.AUTOMATION_RUNTIME_MODE === 'on') return true;
  if (config.AUTOMATION_RUNTIME_MODE === 'canary') return canaryWorkspaceIds.has(workspaceId);
  return false;
}

async function claim(limit: number): Promise<OutboxRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<OutboxRow>(
      `WITH candidates AS (
         SELECT outbox.id
         FROM automation_dispatch_outbox outbox
         LEFT JOIN workflow_runs run ON outbox.source_type='workflow' AND run.id=outbox.run_id
         WHERE outbox.status IN ('pending','failed')
           AND outbox.next_attempt_at <= NOW()
           AND (outbox.claim_expires_at IS NULL OR outbox.claim_expires_at < NOW())
           AND (outbox.source_type <> 'workflow' OR run.status='queued')
         ORDER BY outbox.created_at,outbox.id
         FOR UPDATE OF outbox SKIP LOCKED
         LIMIT $1
       )
       UPDATE automation_dispatch_outbox outbox
       SET status='claimed',claim_owner=$2,claim_expires_at=NOW()+INTERVAL '30 seconds',updated_at=NOW()
       FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.*`,
      [limit, workerId]
    );
    return result.rows;
  });
}

async function retry(row: OutboxRow, error: unknown, startedAt: number): Promise<void> {
  const attempt = row.attempt_count + 1;
  const message = (error instanceof Error ? error.message : 'Dispatch failed').slice(0, 500);
  const terminal = attempt >= 3;
  const retried = await db.query(
    `UPDATE automation_dispatch_outbox SET status=$2,attempt_count=$3,
       next_attempt_at=NOW()+($4::text||' seconds')::interval,claim_owner=NULL,claim_expires_at=NULL,
       last_error_code='DISPATCH_FAILED',last_error_message=$5,updated_at=NOW()
     WHERE id=$1 AND status='claimed'
     RETURNING id`,
    [row.id, terminal ? 'needs_review' : 'failed', attempt, Math.min(30, 2 ** attempt), message]
  );
  if (!retried.rowCount) {
    incrementAutomationDispatch(row.source_type, 'stale_claim');
    return;
  }
  if (terminal && row.source_type === 'workflow') {
    await updateWorkflowRun(row.run_id, {
      status: 'needs_review', errorCode: 'DISPATCH_RETRIES_EXHAUSTED', errorMessage: message
    });
    await recomputeWorkflowExecutionStatusForRun(row.run_id);
  }
  logger.warn({ outboxId: row.id, runId: row.run_id, attempt, terminal }, 'Automation dispatch failed');
  incrementAutomationDispatch(row.source_type, terminal ? 'needs_review' : 'retry');
  observeAutomationDispatchDurationMs(row.source_type, terminal ? 'needs_review' : 'retry', Date.now() - startedAt);
}

async function deliver(row: OutboxRow): Promise<void> {
  const startedAt = Date.now();
  if (!workspaceEnabled(row.workspace_id)) {
    await db.query(
      `UPDATE automation_dispatch_outbox SET status='pending',claim_owner=NULL,claim_expires_at=NULL,
       next_attempt_at=NOW()+INTERVAL '30 seconds',updated_at=NOW() WHERE id=$1`, [row.id]
    );
    incrementAutomationDispatch(row.source_type, 'deferred');
    return;
  }
  if (row.source_type !== 'workflow') return retry(row, new Error(`Unsupported outbox source ${row.source_type}`), startedAt);
  const run = await getWorkflowRun(row.run_id);
  if (!run || run.status !== 'queued') {
    await db.query("UPDATE automation_dispatch_outbox SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW() WHERE id=$1", [row.id]);
    incrementAutomationDispatch(row.source_type, 'stale_claim');
    return;
  }
  try {
    const dispatching = await updateWorkflowRunIfStatus(run.id, ['queued'], { status: 'dispatching' });
    if (!dispatching) {
      await db.query(
        `UPDATE automation_dispatch_outbox
         SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND status='claimed'`,
        [row.id]
      );
      incrementAutomationDispatch(row.source_type, 'stale_claim');
      return;
    }
    await dispatchWorkflowRunToExecutionEngine(run);
    let activated = false;
    await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE workflow_runs
         SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
         WHERE id=$1 AND status='dispatching' AND cancellation_requested_at IS NULL
         RETURNING id`,
        [run.id]
      );
      activated = Boolean(result.rowCount);
      if (activated && !run.parentRunId) {
        await client.query(
          `UPDATE workflow_executions
           SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
           WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`,
          [run.executionId]
        );
      }
      await client.query(
        `UPDATE automation_dispatch_outbox
         SET status=$2,attempt_count=attempt_count+1,
             delivered_at=CASE WHEN $2='delivered' THEN NOW() ELSE delivered_at END,
             claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND status='claimed'`,
        [row.id, activated ? 'delivered' : 'cancelled']
      );
    });
    if (!activated) {
      await cancelRunInExecutionEngine(run.id).catch(() => undefined);
    }
    incrementAutomationDispatch(row.source_type, activated ? 'delivered' : 'stale_claim');
    observeAutomationDispatchDurationMs(
      row.source_type,
      activated ? 'delivered' : 'stale_claim',
      Date.now() - startedAt
    );
  } catch (error) {
    await db.query(
      `UPDATE workflow_runs SET status='queued',updated_at=NOW()
       WHERE id=$1 AND status='dispatching' AND cancellation_requested_at IS NULL`,
      [run.id]
    );
    await retry(row, error, startedAt);
  }
}

export async function runAutomationOutboxTick(limit = 25): Promise<number> {
  if (config.AUTOMATION_RUNTIME_MODE === 'off' || config.AUTOMATION_RUNTIME_MODE === 'shadow') return 0;
  const rows = await claim(limit);
  for (const row of rows) await deliver(row);
  return rows.length;
}
