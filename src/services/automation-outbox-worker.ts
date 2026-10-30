import { serviceLifecycle } from './service-lifecycle.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementAutomationDispatch, observeAutomationDispatchDurationMs } from '../metrics.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { settleWorkflowDispatch, type DispatchSettlement } from '../store/repository-workflow-dispatch.js';
import { withTransaction } from '../store/repository-transaction.js';
import {
  ExecutionEngineDrainingError,
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
  claim_owner: string;
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
         WHERE outbox.source_type='workflow' AND (
             outbox.status IN ('pending','failed')
             OR (outbox.status='claimed' AND outbox.claim_expires_at < NOW())
           )
           AND outbox.next_attempt_at <= NOW()
         ORDER BY outbox.created_at,outbox.id
         FOR UPDATE OF outbox SKIP LOCKED
         LIMIT $1
       )
       UPDATE automation_dispatch_outbox outbox
       SET status='claimed',claim_owner=$2,claim_expires_at=NOW()+($3::int*INTERVAL '1 millisecond'),updated_at=NOW()
       FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.*`,
      [limit, `${workerId}:${randomUUID()}`, Math.max(300_000, config.EXECUTION_ENGINE_TIMEOUT_MS + 30_000)]
    );
    return result.rows;
  });
}

function recordOutcome(row: OutboxRow, outcome: DispatchSettlement, startedAt: number): void {
  incrementAutomationDispatch(row.source_type, outcome);
  observeAutomationDispatchDurationMs(row.source_type, outcome, Date.now() - startedAt);
}

async function deliver(row: OutboxRow): Promise<void> {
  const startedAt = Date.now();
  if (!workspaceEnabled(row.workspace_id)) {
    const updated = await db.query(
      `UPDATE automation_dispatch_outbox SET status='pending',claim_owner=NULL,claim_expires_at=NULL,
       next_attempt_at=NOW()+INTERVAL '30 seconds',updated_at=NOW()
       WHERE id=$1 AND status='claimed' AND claim_owner=$2 AND claim_expires_at>clock_timestamp()`,
      [row.id, row.claim_owner]
    );
    recordOutcome(row, updated.rowCount ? 'deferred' : 'stale_claim', startedAt);
    return;
  }
  const prepared = await settleWorkflowDispatch(row, { kind: 'prepare' });
  if (prepared !== 'ready') {
    recordOutcome(row, prepared, startedAt);
    return;
  }
  const run = await getWorkflowRun(row.run_id);
  if (!run || !['queued', 'dispatching'].includes(run.status)) {
    recordOutcome(row, await settleWorkflowDispatch(row, { kind: 'prepare' }), startedAt);
    return;
  }
  // Only transport failures enter recovery. A persistence failure must leave the
  // owned claim intact for later reconciliation, not charge another delivery.
  let outcome: Parameters<typeof settleWorkflowDispatch>[1] = { kind: 'acknowledged' };
  try {
    await dispatchWorkflowRunToExecutionEngine(run);
  } catch (error) {
    outcome = {
      kind: 'failed', safeDrain: error instanceof ExecutionEngineDrainingError,
      message: (error instanceof Error ? error.message : 'Dispatch failed').slice(0, 500)
    };
  }
  const settled = await settleWorkflowDispatch(row, outcome);
  recordOutcome(row, settled, startedAt);
  if (settled === 'cancelled' && outcome.kind === 'acknowledged') {
    await cancelRunInExecutionEngine(run.id).catch(() => undefined);
  }
  if (settled === 'retry' || settled === 'needs_review') {
    logger.warn({ outboxId: row.id, runId: row.run_id, outcome: settled }, 'Automation dispatch recovery');
  }
}

export async function runAutomationOutboxTick(limit = 25): Promise<number> {
  if (!serviceLifecycle.accepting || !config.WORKSPACE_DISPATCH_ENABLED) return 0;
  if (config.AUTOMATION_RUNTIME_MODE === 'off' || config.AUTOMATION_RUNTIME_MODE === 'shadow') return 0;
  let processed = 0;
  while (processed < limit && serviceLifecycle.accepting && config.WORKSPACE_DISPATCH_ENABLED) {
    const rows = await claim(1);
    if (!rows.length) break;
    await deliver(rows[0]);
    processed += 1;
  }
  return processed;
}
