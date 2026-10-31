import { serviceLifecycle } from './service-lifecycle.js';
import { runConversationDispatchTick } from './conversation-dispatch-worker.js';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { lockReservation, settleRunCapacity } from '../store/repository-run-capacity.js';
import { withTransaction } from '../store/repository-transaction.js';
import { reconcileMaintainedWorkflowRun, reconcileStaleWorkflowMaintenanceSummaries } from '../store/repository-workflow-capacity-maintenance.js';
import { executionAdmissionTimeSql } from '../store/repository-execution-admission.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { cleanupWorkspacePolicyReceipts } from '../store/repository-workspace-policy-read.js';
import { assertExecutionActive } from './workspace-execution-access.js';
import { cancelRunInExecutionEngine, dispatchWorkflowRunToExecutionEngine } from './execution-engine-client.js';

async function updateMaintainedRuns(table: 'runs' | 'workflow_runs', statement: string, values: unknown[]) {
  const cancelledChildren: string[] = [];
  const updated = await withTransaction(async (client) => {
    // Approval and graph writers have different lock orders. Roll back contention
    // so the next maintenance tick can retry without leaving a partial transition.
    await client.query("SET LOCAL lock_timeout='250ms'");
    const updated = await client.query<{ id: string }>(`${statement} RETURNING id`, values);
    if (table === 'workflow_runs') {
      for (const run of updated.rows) cancelledChildren.push(...await reconcileMaintainedWorkflowRun(client, run.id));
    }
    return updated;
  });
  await cancelMaintainedChildren(cancelledChildren);
  return updated;
}

async function cancelMaintainedChildren(runIds: string[]): Promise<void> {
  for (const runId of runIds) {
    await cancelRunInExecutionEngine(runId).catch((err) => logger.warn({ err, runId }, 'Terminated coordinator child cancellation deferred; capacity authority revoked'));
  }
}

const expiredReservationSql = `r.settled_at IS NULL AND (
  ($1::boolean AND r.state='executing' AND r.lease_expires_at<=clock_timestamp()) OR
  (r.state='queued' AND r.queue_expires_at<=clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM runs WHERE id=r.run_id AND status IN ('running','waiting_for_approval'))
    AND NOT EXISTS(SELECT 1 FROM workflow_runs WHERE id=r.run_id AND status IN ('running','waiting_for_approval')))
)`;

async function expireRunAuthority(runId: string): Promise<boolean> {
  try {
    const cancelledChildren: string[] = [];
    const expired = await withTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='250ms'");
      await lockReservation(client, runId);
      // Do not wait while holding workspace/reservation locks for a run writer
      // that may itself need them (approval resume or execution completion).
      for (const table of ['runs', 'workflow_runs'] as const) {
        await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE NOWAIT`, [runId]);
      }
      await client.query(`SELECT e.id FROM workflow_executions e JOIN workflow_runs r ON r.execution_id=e.id
        WHERE r.id=$1 FOR UPDATE OF e NOWAIT`, [runId]);
      const expired = await client.query(`SELECT 1 FROM workspace_run_reservations r
        WHERE r.run_id=$2 AND ${expiredReservationSql}`, [config.WORKSPACE_CAPACITY_ENABLED, runId]);
      if (!expired.rowCount) return false;
      for (const table of ['runs', 'workflow_runs'] as const) {
        await client.query(`UPDATE ${table} SET status='failed',ended_at=clock_timestamp(),error_code='EXECUTION_AUTHORITY_LOST',
          error_message='Execution authority expired; verify uncertain operations before retrying'
          WHERE id=$1 AND status NOT IN ('completed','failed','cancelled','waiting_for_approval')`, [runId]);
      }
      cancelledChildren.push(...await reconcileMaintainedWorkflowRun(client, runId));
      return true;
    });
    await cancelMaintainedChildren(cancelledChildren);
    return expired;
  } catch (error) {
    if (['55P03', '40P01'].includes((error as { code?: string }).code || '')) return false;
    throw error;
  }
}

/** Cancellation intent survives a crash or a rapid suspend/restore sequence. */
async function maintainWorkspaceCapacity(): Promise<void> {
  const holds = await db.query<{ workspace_id: string; requested_at: string }>(
    'SELECT workspace_id,requested_at::text AS requested_at FROM workspace_lifecycle_outbox WHERE completed_at IS NULL ORDER BY requested_at LIMIT 50');
  for (const hold of holds.rows) {
    for (const table of ['runs', 'workflow_runs'] as const) {
      const cancelled = await updateMaintainedRuns(table, `UPDATE ${table} SET
        status=CASE WHEN status IN ('queued','waiting_for_approval') OR EXISTS (
          SELECT 1 FROM workspace_run_reservations r WHERE r.run_id=${table}.id AND r.state='parked'
        ) THEN 'cancelled' ELSE 'cancelling' END,
        ended_at=CASE WHEN status IN ('queued','waiting_for_approval') OR EXISTS (
          SELECT 1 FROM workspace_run_reservations r WHERE r.run_id=${table}.id AND r.state='parked'
        ) THEN clock_timestamp() ELSE ended_at END,
        error_code='WORKSPACE_SUSPENDED',error_message='Workspace suspended'
        WHERE workspace_id=$1 AND ${executionAdmissionTimeSql(table)}<=$2 AND status IN ('queued','dispatching','running','waiting_for_approval','cancelling')`,
      [hold.workspace_id, hold.requested_at]);
      for (const run of cancelled.rows) {
        await cancelRunInExecutionEngine(run.id).catch((err) => logger.warn({ err, runId: run.id }, 'Cancellation will also be enforced at execution boundaries'));
      }
    }
    await db.query(`UPDATE automation_dispatch_outbox SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL
      WHERE workspace_id=$1 AND created_at<=$2 AND status<>'delivered'`, [hold.workspace_id, hold.requested_at]);
    await db.query(`UPDATE target_auto_triage_jobs SET status='skipped',error_code='WORKSPACE_SUSPENDED',lease_owner=NULL,lease_expires_at=NULL
      WHERE workspace_id=$1 AND created_at<=$2 AND run_id IS NULL AND status IN ('queued','processing','blocked')`, [hold.workspace_id, hold.requested_at]);
    await db.query(`UPDATE target_insights_checkpoint_jobs SET status='skipped',last_error='WORKSPACE_SUSPENDED',lease_owner=NULL,lease_expires_at=NULL
      WHERE workspace_id=$1 AND last_activity_at<=$2 AND status IN ('queued','processing','failed')`, [hold.workspace_id, hold.requested_at]);
    await db.query(`UPDATE run_tool_approvals a SET status='expired' FROM runs r
      WHERE a.run_id=r.id AND r.workspace_id=$1 AND ${executionAdmissionTimeSql('r')}<=$2 AND a.status='pending'`, [hold.workspace_id, hold.requested_at]);
    await db.query(`UPDATE workflow_run_approvals a SET status='expired' FROM workflow_runs r
      WHERE a.run_id=r.id AND r.workspace_id=$1 AND ${executionAdmissionTimeSql('r')}<=$2 AND a.status='pending'`, [hold.workspace_id, hold.requested_at]);
    await db.query(`DELETE FROM workflow_dependency_continuations WHERE run_id IN
      (SELECT id FROM workflow_runs WHERE workspace_id=$1 AND ${executionAdmissionTimeSql('workflow_runs')}<=$2)`, [hold.workspace_id, hold.requested_at]);
    await db.query('UPDATE workspace_lifecycle_outbox SET completed_at=clock_timestamp() WHERE workspace_id=$1 AND requested_at=$2', [hold.workspace_id, hold.requested_at]);
  }
  // A cancelled owner can disappear without a callback. Keep uncertain operations
  // charged until their deadline, then finish the durable cancellation.
  for (const table of ['runs', 'workflow_runs'] as const) {
    await updateMaintainedRuns(table, `UPDATE ${table} run SET status='cancelled',ended_at=clock_timestamp()
      WHERE run.status='cancelling' AND EXISTS (
        SELECT 1 FROM workspace_run_reservations r JOIN workspace_lifecycle_outbox o ON o.workspace_id=r.workspace_id
        WHERE r.run_id=run.id AND r.workspace_id=run.workspace_id AND o.requested_at>=r.created_at
        AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM workspace_run_operations op WHERE op.run_id=r.run_id
          AND op.finished_at IS NULL AND op.deadline>clock_timestamp()))`, []);
  }
  const expired = await db.query<{ run_id: string }>(`SELECT r.run_id FROM workspace_run_reservations r
    WHERE ${expiredReservationSql} LIMIT 200`, [config.WORKSPACE_CAPACITY_ENABLED]);
  for (const { run_id: runId } of expired.rows) {
    if (await expireRunAuthority(runId)) await settleRunCapacity(runId);
  }
  const finished = await db.query<{ run_id: string }>(`SELECT r.run_id FROM workspace_run_reservations r WHERE r.settled_at IS NULL AND (
    r.state='settling' OR
    (r.pool='insights' AND NOT EXISTS(SELECT 1 FROM target_insights_checkpoint_jobs WHERE capacity_run_id=r.run_id)) OR
    EXISTS(SELECT 1 FROM runs WHERE id=r.run_id AND status IN ('completed','failed','cancelled')) OR
    EXISTS(SELECT 1 FROM workflow_runs WHERE id=r.run_id AND status IN ('completed','failed','cancelled','needs_review')) OR
    EXISTS(SELECT 1 FROM target_auto_triage_jobs WHERE reserved_run_id=r.run_id AND run_id IS NULL AND status IN ('skipped','failed')) OR
    EXISTS(SELECT 1 FROM target_insights_checkpoint_jobs WHERE capacity_run_id=r.run_id AND status IN ('skipped','applied','noop','failed'))
    ) LIMIT 200`);
  for (const row of finished.rows) await settleRunCapacity(row.run_id);
  await cancelMaintainedChildren(await reconcileStaleWorkflowMaintenanceSummaries());
}

let maintenanceRunning = false;
export async function runWorkspaceCapacityMaintenance(): Promise<void> {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    await maintainWorkspaceCapacity();
    await runConversationDispatchTick();
    await cleanupWorkspacePolicyReceipts();
    if (!serviceLifecycle.accepting) return;
    const resumable = await db.query<{ run_id: string }>(`SELECT c.run_id FROM workflow_dependency_continuations c
      JOIN workspace_run_reservations r ON r.run_id=c.run_id
      JOIN workflow_runs parent ON parent.id=c.run_id
      WHERE r.state='parked' AND r.settled_at IS NULL AND parent.status IN ('running','dispatching')
      AND NOT EXISTS(SELECT 1 FROM workflow_runs child WHERE child.parent_run_id=c.run_id
        AND child.status NOT IN ('completed','failed','cancelled','needs_review')) LIMIT 50`);
    for (const row of resumable.rows) {
      try {
        await assertExecutionActive(row.run_id);
        const run = await getWorkflowRun(row.run_id);
        if (run) await dispatchWorkflowRunToExecutionEngine(run);
      } catch (err) { logger.warn({ err, runId: row.run_id }, 'Dependency continuation redispatch deferred'); }
    }
  } finally { maintenanceRunning = false; }
}
