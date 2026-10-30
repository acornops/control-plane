import type { PoolClient } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { withTransaction } from './repository-transaction.js';
import { recomputeWorkflowExecutionStatus } from './repository-workflow-execution-aggregate.js';

export type WorkflowDispatchClaim = { id: string; run_id: string; claim_owner: string };
type DispatchOutcome = { kind: 'prepare' } | { kind: 'acknowledged' } | { kind: 'failed'; safeDrain: boolean; message: string };
export type DispatchSettlement = 'ready' | 'delivered' | 'recovered' | 'retry' | 'needs_review' | 'cancelled' | 'stale_claim' | 'deferred';

/** Settle only the current claim, preserving callback state and atomic aggregate changes. */
async function settle(client: PoolClient, claim: WorkflowDispatchClaim, outcome: DispatchOutcome): Promise<DispatchSettlement> {
  // Cancellation locks execution -> run -> outbox. NOWAIT also avoids cycles with
  // approval writers that lock the run before recomputing its execution aggregate.
  const execution = await client.query<{ status: string }>(
    `SELECT execution.status FROM workflow_executions execution
     JOIN workflow_runs run ON run.execution_id=execution.id WHERE run.id=$1
     FOR UPDATE OF execution NOWAIT`, [claim.run_id]
  );
  const runs = await client.query<{ status: string; cancellation_requested_at: Date | null }>(
    'SELECT status,cancellation_requested_at FROM workflow_runs WHERE id=$1 FOR UPDATE NOWAIT', [claim.run_id]
  );
  const owned = await client.query<{ attempt_count: number }>(
    `SELECT attempt_count FROM automation_dispatch_outbox
     WHERE id=$1 AND status='claimed' AND claim_owner=$2 AND claim_expires_at>clock_timestamp()
     FOR UPDATE NOWAIT`, [claim.id, claim.claim_owner]
  );
  if (!owned.rowCount) return 'stale_claim';

  const run = runs.rows[0];
  const terminal = run && ['completed', 'failed', 'cancelled'].includes(run.status);
  const cancelled = !run || run.status === 'cancelled'
    || (!terminal && (run.status === 'cancelling' || Boolean(run.cancellation_requested_at)));
  const dispatchable = run && !cancelled && ['queued', 'dispatching'].includes(run.status);
  // Do not invent a new run state to reconcile an inconsistent terminal aggregate.
  if (dispatchable && ['completed', 'failed', 'cancelled'].includes(execution.rows[0]?.status)) return 'deferred';

  const attempted = outcome.kind !== 'prepare';
  const safeDrain = outcome.kind === 'failed' && outcome.safeDrain;
  const attempt = owned.rows[0].attempt_count + (attempted && !safeDrain ? 1 : 0);
  const exhausted = outcome.kind === 'failed' && !safeDrain && attempt >= 3;
  let status: string;
  let result: DispatchSettlement;

  if (cancelled) {
    status = 'cancelled';
    result = 'cancelled';
  } else if (run.status === 'needs_review') {
    status = 'needs_review';
    result = 'needs_review';
  } else if (!dispatchable || outcome.kind === 'acknowledged') {
    status = 'delivered';
    result = outcome.kind === 'acknowledged' ? 'delivered' : 'recovered';
  } else if (outcome.kind === 'prepare') {
    await client.query(
      "UPDATE workflow_runs SET status='dispatching',updated_at=NOW() WHERE id=$1 AND status='queued'",
      [claim.run_id]
    );
    return 'ready';
  } else {
    status = exhausted ? 'needs_review' : 'failed';
    result = exhausted ? 'needs_review' : 'retry';
    await client.query(
      `UPDATE workflow_runs SET status=$2,
         error_code=CASE WHEN $3 THEN 'DISPATCH_RETRIES_EXHAUSTED' ELSE error_code END,
         error_message=CASE WHEN $3 THEN $4 ELSE error_message END,updated_at=NOW()
       WHERE id=$1 AND status IN ('queued','dispatching') AND cancellation_requested_at IS NULL`,
      [claim.run_id, exhausted ? 'needs_review' : 'queued', exhausted, outcome.message]
    );
    if (exhausted) await recomputeWorkflowExecutionStatus(client, claim.run_id);
  }

  await client.query(
    `UPDATE automation_dispatch_outbox SET status=$2,attempt_count=$3,
       next_attempt_at=CASE WHEN $6 THEN NOW()+($4::int*INTERVAL '1 second') ELSE next_attempt_at END,
       delivered_at=CASE WHEN $2='delivered' THEN NOW() ELSE delivered_at END,
       claim_owner=NULL,claim_expires_at=NULL,
       last_error_code=CASE WHEN $6 THEN 'DISPATCH_FAILED' ELSE last_error_code END,
       last_error_message=CASE WHEN $6 THEN $5::text ELSE last_error_message END,
       updated_at=NOW() WHERE id=$1`,
    [claim.id, status, attempt, Math.min(30, 2 ** attempt), outcome.kind === 'failed' ? outcome.message : null,
      dispatchable && outcome.kind === 'failed']
  );
  return result;
}

/** Retry database lock contention only; never repeat the HTTP operation here. */
export async function settleWorkflowDispatch(claim: WorkflowDispatchClaim, outcome: DispatchOutcome): Promise<DispatchSettlement> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction((client) => settle(client, claim, outcome));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== '55P03' && code !== '40P01') throw error;
      if (attempt >= 2) return 'deferred';
      await delay(attempt === 0 ? 25 : 100);
    }
  }
}
