import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementAutomationDispatch, observeAutomationDispatchDurationMs } from '../metrics.js';
import { getWorkflowRun, updateWorkflowRun } from '../store/repository-workflows.js';
import { withTransaction } from '../store/repository-transaction.js';
import { dispatchWorkflowRunToExecutionEngine } from './execution-engine-client.js';
import { dispatchAgentRunToExecutionEngine } from './execution-engine-client.js';
import { getAgentActivityRecord, updateAgentActivityRecord } from '../store/repository-agents.js';

type OutboxRow = {
  id: string;
  workspace_id: string;
  source_type: 'agent' | 'workflow' | 'target';
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
         LEFT JOIN agent_activity agent_run ON outbox.source_type='agent' AND agent_run.id=outbox.run_id
         WHERE outbox.status IN ('pending','failed')
           AND outbox.next_attempt_at <= NOW()
           AND (outbox.claim_expires_at IS NULL OR outbox.claim_expires_at < NOW())
           AND (outbox.source_type <> 'workflow' OR run.status='queued')
           AND (outbox.source_type <> 'agent' OR agent_run.status='queued')
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
  await db.query(
    `UPDATE automation_dispatch_outbox SET status=$2,attempt_count=$3,
       next_attempt_at=NOW()+($4::text||' seconds')::interval,claim_owner=NULL,claim_expires_at=NULL,
       last_error_code='DISPATCH_FAILED',last_error_message=$5,updated_at=NOW() WHERE id=$1`,
    [row.id, terminal ? 'needs_review' : 'failed', attempt, Math.min(30, 2 ** attempt), message]
  );
  if (terminal && row.source_type === 'workflow') {
    await updateWorkflowRun(row.run_id, {
      status: 'needs_review', errorCode: 'DISPATCH_RETRIES_EXHAUSTED', errorMessage: message
    });
    await db.query(
      `UPDATE workflow_executions SET status='needs_review',error_code='DISPATCH_RETRIES_EXHAUSTED',
       error_message=$2,updated_at=NOW() WHERE id=$1`,
      [row.source_id, message]
    );
  }
  if (terminal && row.source_type === 'agent') {
    await updateAgentActivityRecord(row.run_id, {
      status: 'failed', errorCode: 'DISPATCH_RETRIES_EXHAUSTED', errorMessage: message,
      endedAt: new Date().toISOString()
    });
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
  if (row.source_type === 'agent') {
    const run = await getAgentActivityRecord(row.run_id);
    if (!run || run.status !== 'queued') {
      await db.query("UPDATE automation_dispatch_outbox SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW() WHERE id=$1", [row.id]);
      incrementAutomationDispatch(row.source_type, 'stale_claim');
      return;
    }
    try {
      await dispatchAgentRunToExecutionEngine(run);
      await updateAgentActivityRecord(run.id, { status: 'running', startedAt: new Date().toISOString() });
      await db.query(
        `UPDATE automation_dispatch_outbox SET status='delivered',attempt_count=attempt_count+1,
         delivered_at=NOW(),claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW() WHERE id=$1`, [row.id]
      );
      incrementAutomationDispatch(row.source_type, 'delivered');
      observeAutomationDispatchDurationMs(row.source_type, 'delivered', Date.now() - startedAt);
    } catch (error) {
      await retry(row, error, startedAt);
    }
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
    await updateWorkflowRun(run.id, { status: 'dispatching' });
    await dispatchWorkflowRunToExecutionEngine(run);
    await withTransaction(async (client) => {
      await client.query("UPDATE workflow_runs SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1", [run.id]);
      await client.query(
        "UPDATE workflow_executions SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1",
        [run.executionId]
      );
      await client.query(
        `UPDATE automation_dispatch_outbox SET status='delivered',attempt_count=attempt_count+1,
         delivered_at=NOW(),claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW() WHERE id=$1`, [row.id]
      );
    });
    incrementAutomationDispatch(row.source_type, 'delivered');
    observeAutomationDispatchDurationMs(row.source_type, 'delivered', Date.now() - startedAt);
  } catch (error) {
    await updateWorkflowRun(run.id, { status: 'queued' });
    await retry(row, error, startedAt);
  }
}

export async function runAutomationOutboxTick(limit = 25): Promise<number> {
  if (config.AUTOMATION_RUNTIME_MODE === 'off' || config.AUTOMATION_RUNTIME_MODE === 'shadow') return 0;
  const rows = await claim(limit);
  for (const row of rows) await deliver(row);
  return rows.length;
}
