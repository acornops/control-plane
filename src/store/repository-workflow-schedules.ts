import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { withTransaction } from './repository-transaction.js';
import { computeNextWorkflowScheduleRunAt, requireWorkflowScheduleNextRun, WorkflowScheduleCadenceError } from '../services/workflow-schedule-cron.js';
export {
  computeNextWorkflowScheduleRunAt,
  computeUpcomingWorkflowScheduleRuns,
  summarizeWorkflowScheduleCron,
  validateWorkflowScheduleCron,
  validateWorkflowScheduleTimezone
} from '../services/workflow-schedule-cron.js';
import type {
  WorkflowScheduleInput,
  WorkflowScheduleLastStatus,
  WorkflowSchedulePatch,
  WorkflowScheduleRecord
} from '../types/workflows.js';

function nowIso(now = new Date()): string {
  return now.toISOString();
}

type ScheduleRow = QueryResultRow;
function mapSchedule(row: ScheduleRow): WorkflowScheduleRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
    name: row.name, status: row.status,
    cron: row.cron, timezone: row.timezone, createdBy: row.created_by,
    principal: row.principal,
    updatedBy: row.updated_by, createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : undefined,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : undefined,
    lastStatus: row.last_status || undefined,
    lastExecutionId: row.last_execution_id || undefined,
    lastRunId: row.last_run_id || undefined,
    lastError: row.last_error || undefined
  };
}

export async function createWorkflowSchedule(params: {
  workspaceId: string;
  input: WorkflowScheduleInput;
  actorUserId: string;
  now?: Date;
}): Promise<WorkflowScheduleRecord> {
  const now = params.now || new Date();
  const createdAt = nowIso(now);
  const status = params.input.status || (params.input.enabled === false ? 'paused' : 'enabled');
  const schedule: WorkflowScheduleRecord = {
    id: randomUUID(),
    workspaceId: params.workspaceId,
    workflowId: params.input.workflowId,
    name: params.input.name.trim(),
    status,
    cron: params.input.cron.trim(),
    timezone: params.input.timezone.trim(),
    principal: { ...params.input.principal },
    createdBy: { userId: params.actorUserId },
    updatedBy: { userId: params.actorUserId },
    createdAt,
    updatedAt: createdAt,
    nextRunAt: status === 'enabled' ? requireWorkflowScheduleNextRun(params.input.cron, now, params.input.timezone.trim()) : undefined
  };
  const result = await db.query<ScheduleRow>(
    `INSERT INTO workflow_schedules (
      id,workspace_id,workflow_id,name,status,cron,timezone,
      principal,created_by,updated_by,next_run_at,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$11) RETURNING *`,
    [schedule.id, schedule.workspaceId, schedule.workflowId, schedule.name,
     schedule.status, schedule.cron, schedule.timezone, schedule.principal,
     schedule.createdBy, schedule.nextRunAt || null, schedule.createdAt]
  );
  return mapSchedule(result.rows[0]);
}

export async function listWorkflowSchedules(workspaceId: string): Promise<WorkflowScheduleRecord[]> {
  const result = await db.query<ScheduleRow>(
    'SELECT * FROM workflow_schedules WHERE workspace_id=$1 ORDER BY next_run_at NULLS LAST,name,id', [workspaceId]
  );
  return result.rows.map(mapSchedule);
}

export async function getWorkflowSchedule(scheduleId: string): Promise<WorkflowScheduleRecord | null> {
  const result = await db.query<ScheduleRow>('SELECT * FROM workflow_schedules WHERE id=$1', [scheduleId]);
  return result.rowCount ? mapSchedule(result.rows[0]) : null;
}

export async function updateWorkflowScheduleRecord(
  scheduleId: string,
  patch: WorkflowSchedulePatch,
  actorUserId: string,
  now = new Date()
): Promise<WorkflowScheduleRecord | null> {
  const current = await getWorkflowSchedule(scheduleId);
  if (!current) return null;
  const cron = patch.cron?.trim() || current.cron;
  const timezone = patch.timezone?.trim() || current.timezone;
  const status = patch.status || (typeof patch.enabled === 'boolean' ? (patch.enabled ? 'enabled' : 'paused') : current.status);
  const updated: WorkflowScheduleRecord = {
    ...current,
    workflowId: patch.workflowId || current.workflowId,
    name: patch.name?.trim() || current.name,
    status,
    cron,
    timezone,
    principal: patch.principal ? { ...patch.principal } : current.principal,
    updatedBy: { userId: actorUserId },
    updatedAt: nowIso(now),
    nextRunAt: status === 'enabled' ? requireWorkflowScheduleNextRun(cron, now, timezone) : undefined
  };
  const result = await db.query<ScheduleRow>(
    `UPDATE workflow_schedules SET workflow_id=$2,name=$3,status=$4,cron=$5,timezone=$6,
      principal=$7,updated_by=$8,next_run_at=$9,updated_at=$10
     WHERE id=$1 RETURNING *`,
    [scheduleId, updated.workflowId, updated.name, updated.status, updated.cron,
     updated.timezone, updated.principal, updated.updatedBy,
     updated.nextRunAt || null, updated.updatedAt]
  );
  return result.rowCount ? mapSchedule(result.rows[0]) : null;
}

export async function pauseWorkflowScheduleForConfigurationChange(
  scheduleId: string,
  error: string,
  actorUserId: string,
  now = new Date()
): Promise<WorkflowScheduleRecord | null> {
  const result = await db.query<ScheduleRow>(
    `UPDATE workflow_schedules
     SET status='paused',last_status='auto_paused',last_error=$2,next_run_at=NULL,
       lease_owner=NULL,lease_expires_at=NULL,updated_by=$3,updated_at=$4
     WHERE id=$1 AND status='enabled' RETURNING *`,
    [scheduleId, error, { userId: actorUserId }, nowIso(now)]
  );
  return result.rowCount ? mapSchedule(result.rows[0]) : null;
}

export async function deleteWorkflowScheduleRecord(scheduleId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM workflow_schedules WHERE id=$1', [scheduleId]);
  return Boolean(result.rowCount);
}

export async function pauseStrandedWorkflowSchedule(scheduleId: string, now = new Date()): Promise<WorkflowScheduleRecord | null> {
  // Recheck under the write lock: an operator may have repaired the claimed
  // schedule since the worker read it. This is maintenance, not a run attempt.
  const result = await db.query<ScheduleRow>(
    `UPDATE workflow_schedules
     SET status='paused',last_status='auto_paused',last_error=$2,
       lease_owner=NULL,lease_expires_at=NULL,updated_at=$3
     WHERE id=$1 AND status='enabled' AND next_run_at IS NULL RETURNING *`,
    [scheduleId, 'This schedule has no next run. Review its cadence and enable it again.', nowIso(now)]
  );
  return result.rowCount ? mapSchedule(result.rows[0]) : null;
}

export async function listDueWorkflowSchedules(now = new Date(), limit = 50): Promise<WorkflowScheduleRecord[]> {
  return withTransaction(async (client) => {
    const result = await client.query<ScheduleRow>(
      `SELECT * FROM workflow_schedules
       WHERE status='enabled' AND (next_run_at <= $1 OR next_run_at IS NULL)
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT $2`, [now, Math.max(1, limit)]
    );
    if (result.rows.length) {
      await client.query(
        `UPDATE workflow_schedules SET lease_owner=$1,lease_expires_at=NOW()+INTERVAL '30 seconds'
         WHERE id=ANY($2::text[])`, ['automation-scheduler', result.rows.map((row) => row.id)]
      );
    }
    return result.rows.map(mapSchedule);
  });
}

export async function recordWorkflowScheduleDispatch(
  scheduleId: string,
  status: WorkflowScheduleLastStatus,
  params: { now?: Date; error?: string; executionId?: string; runId?: string } = {}
): Promise<WorkflowScheduleRecord | null> {
  const current = await getWorkflowSchedule(scheduleId);
  if (!current) return null;
  const now = params.now || new Date();
  const nextRunAt = status === 'auto_paused' ? undefined : computeNextWorkflowScheduleRunAt(current.cron, now, current.timezone);
  const cadenceFailed = status !== 'auto_paused' && !nextRunAt;
  const paused = status === 'auto_paused' || cadenceFailed;
  const updated: WorkflowScheduleRecord = {
    ...current,
    status: paused ? 'paused' : current.status,
    lastRunAt: nowIso(now),
    lastStatus: cadenceFailed ? 'auto_paused' : status,
    lastExecutionId: params.executionId || current.lastExecutionId,
    lastRunId: params.runId || current.lastRunId,
    lastError: cadenceFailed ? new WorkflowScheduleCadenceError().message : params.error,
    nextRunAt,
    updatedAt: nowIso(now)
  };
  const result = await db.query<ScheduleRow>(
    `UPDATE workflow_schedules SET status=$2,last_run_at=$3,last_status=$4,last_error=$5,next_run_at=$6,
      last_execution_id=COALESCE($7,last_execution_id),last_run_id=COALESCE($8,last_run_id),
      lease_owner=NULL,lease_expires_at=NULL,updated_at=$3 WHERE id=$1 RETURNING *`,
    [
      scheduleId,
      updated.status,
      updated.lastRunAt,
      updated.lastStatus,
      updated.lastError || null,
      updated.nextRunAt || null,
      params.executionId || null,
      params.runId || null
    ]
  );
  return result.rowCount ? mapSchedule(result.rows[0]) : null;
}

export function resetWorkflowScheduleRepositoryForTests(): void {}
