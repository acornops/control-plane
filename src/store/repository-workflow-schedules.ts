import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { withTransaction } from './repository-transaction.js';
import type {
  WorkflowScheduleInput,
  WorkflowScheduleLastStatus,
  WorkflowSchedulePatch,
  WorkflowScheduleRecord
} from '../types/workflows.js';

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function cloneSchedule(schedule: WorkflowScheduleRecord): WorkflowScheduleRecord {
  return {
    ...schedule,
    inputs: { ...schedule.inputs },
    approvedContextGrants: [...schedule.approvedContextGrants],
    principal: { ...schedule.principal },
    createdBy: { ...schedule.createdBy },
    updatedBy: { ...schedule.updatedBy }
  };
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  const parts = field.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  for (const part of parts) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;
    if (base === '*') {
      for (let value = min; value <= max; value += step) values.add(value);
      continue;
    }
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < min || end > max || start > end) return null;
      for (let value = start; value <= end; value += step) values.add(value);
      continue;
    }
    const value = Number(base);
    if (!Number.isInteger(value) || value < min || value > max) return null;
    values.add(value);
  }
  return values;
}

export function validateWorkflowScheduleCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return Boolean(
    parseCronField(fields[0], 0, 59) &&
    parseCronField(fields[1], 0, 23) &&
    parseCronField(fields[2], 1, 31) &&
    parseCronField(fields[3], 1, 12) &&
    parseCronField(fields[4], 0, 7)
  );
}

export function validateWorkflowScheduleTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function dateParts(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  if (timezone === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay()
    };
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: weekdays[parts.weekday] ?? date.getUTCDay()
  };
}

function cronMatches(expression: string, date: Date, timezone: string): boolean {
  const fields = expression.trim().split(/\s+/);
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const day = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const weekday = parseCronField(fields[4], 0, 7);
  if (!minute || !hour || !day || !month || !weekday) return false;
  const parts = dateParts(date, timezone);
  return (
    minute.has(parts.minute) &&
    hour.has(parts.hour) &&
    day.has(parts.day) &&
    month.has(parts.month) &&
    (weekday.has(parts.weekday) || (parts.weekday === 0 && weekday.has(7)))
  );
}

export function computeNextWorkflowScheduleRunAt(expression: string, from = new Date(), timezone = 'UTC'): string | undefined {
  if (!validateWorkflowScheduleCron(expression)) return undefined;
  if (!validateWorkflowScheduleTimezone(timezone)) return undefined;
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    if (cronMatches(expression, cursor, timezone)) return cursor.toISOString();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return undefined;
}

export function computeUpcomingWorkflowScheduleRuns(
  expression: string,
  timezone: string,
  count = 5,
  from = new Date()
): string[] {
  const runs: string[] = [];
  let cursor = from;
  for (let index = 0; index < Math.max(1, Math.min(10, count)); index += 1) {
    const next = computeNextWorkflowScheduleRunAt(expression, cursor, timezone);
    if (!next) break;
    runs.push(next);
    cursor = new Date(next);
  }
  return runs;
}

export function summarizeWorkflowScheduleCron(expression: string, timezone: string): string {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (day === '*' && month === '*' && weekday === '*') return `Every day at ${time} (${timezone})`;
  if (day === '*' && month === '*' && weekday === '1-5') return `Weekdays at ${time} (${timezone})`;
  if (day === '*' && month === '*' && /^\d(?:,\d)*$/.test(weekday)) return `Selected weekdays at ${time} (${timezone})`;
  if (day === '*' && month === '*' && /^\d$/.test(weekday)) return `Weekly at ${time} (${timezone})`;
  return `Cron ${expression.trim()} (${timezone})`;
}

type ScheduleRow = QueryResultRow;
function mapSchedule(row: ScheduleRow): WorkflowScheduleRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
    workflowVersion: row.workflow_version, parameterSignature: row.parameter_signature,
    name: row.name, status: row.status,
    cron: row.cron, timezone: row.timezone, inputs: row.inputs || {},
    approvedContextGrants: row.approved_context_grants || [], createdBy: row.created_by,
    principal: row.principal,
    updatedBy: row.updated_by, createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : undefined,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : undefined,
    lastStatus: row.last_status || undefined, lastError: row.last_error || undefined
  };
}

export async function createWorkflowSchedule(params: {
  workspaceId: string;
  workflowVersion: number;
  parameterSignature: string;
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
    workflowVersion: params.workflowVersion,
    parameterSignature: params.parameterSignature,
    name: params.input.name.trim(),
    status,
    cron: params.input.cron.trim(),
    timezone: params.input.timezone.trim(),
    inputs: { ...params.input.inputs },
    approvedContextGrants: [...new Set(params.input.approvedContextGrants || [])],
    principal: { ...params.input.principal },
    createdBy: { userId: params.actorUserId },
    updatedBy: { userId: params.actorUserId },
    createdAt,
    updatedAt: createdAt,
    nextRunAt: status === 'enabled' ? computeNextWorkflowScheduleRunAt(params.input.cron, now, params.input.timezone.trim()) : undefined
  };
  const result = await db.query<ScheduleRow>(
    `INSERT INTO workflow_schedules (
      id,workspace_id,workflow_id,workflow_version,parameter_signature,name,status,cron,timezone,inputs,
      approved_context_grants,principal,created_by,updated_by,next_run_at,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$15) RETURNING *`,
    [schedule.id, schedule.workspaceId, schedule.workflowId, schedule.workflowVersion, schedule.parameterSignature, schedule.name,
     schedule.status, schedule.cron, schedule.timezone, JSON.stringify(schedule.inputs), JSON.stringify(schedule.approvedContextGrants),
     schedule.principal, schedule.createdBy, schedule.nextRunAt || null, schedule.createdAt]
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
  patch: WorkflowSchedulePatch & { workflowVersion?: number; parameterSignature?: string },
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
    workflowVersion: patch.workflowVersion || current.workflowVersion,
    parameterSignature: patch.parameterSignature || current.parameterSignature,
    name: patch.name?.trim() || current.name,
    status,
    cron,
    timezone,
    inputs: patch.inputs ? { ...patch.inputs } : current.inputs,
    approvedContextGrants: patch.approvedContextGrants ? [...new Set(patch.approvedContextGrants)] : current.approvedContextGrants,
    principal: patch.principal ? { ...patch.principal } : current.principal,
    updatedBy: { userId: actorUserId },
    updatedAt: nowIso(now),
    nextRunAt: status === 'enabled' ? computeNextWorkflowScheduleRunAt(cron, now, timezone) : undefined
  };
  const result = await db.query<ScheduleRow>(
    `UPDATE workflow_schedules SET workflow_id=$2,workflow_version=$3,parameter_signature=$4,name=$5,status=$6,cron=$7,timezone=$8,
      inputs=$9,approved_context_grants=$10,principal=$11,updated_by=$12,next_run_at=$13,updated_at=$14
     WHERE id=$1 RETURNING *`,
    [scheduleId, updated.workflowId, updated.workflowVersion, updated.parameterSignature, updated.name, updated.status, updated.cron,
     updated.timezone, JSON.stringify(updated.inputs), JSON.stringify(updated.approvedContextGrants), updated.principal, updated.updatedBy,
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

export async function listDueWorkflowSchedules(now = new Date(), limit = 50): Promise<WorkflowScheduleRecord[]> {
  return withTransaction(async (client) => {
    const result = await client.query<ScheduleRow>(
      `SELECT * FROM workflow_schedules
       WHERE status='enabled' AND next_run_at <= $1
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
  params: { now?: Date; error?: string } = {}
): Promise<WorkflowScheduleRecord | null> {
  const current = await getWorkflowSchedule(scheduleId);
  if (!current) return null;
  const now = params.now || new Date();
  const paused = status === 'auto_paused';
  const updated: WorkflowScheduleRecord = {
    ...current,
    status: paused ? 'paused' : current.status,
    lastRunAt: nowIso(now),
    lastStatus: status,
    lastError: params.error,
    nextRunAt: paused ? undefined : computeNextWorkflowScheduleRunAt(current.cron, now, current.timezone),
    updatedAt: nowIso(now)
  };
  const result = await db.query<ScheduleRow>(
    `UPDATE workflow_schedules SET status=$2,last_run_at=$3,last_status=$4,last_error=$5,next_run_at=$6,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=$3 WHERE id=$1 RETURNING *`,
    [scheduleId, updated.status, updated.lastRunAt, updated.lastStatus, updated.lastError || null, updated.nextRunAt || null]
  );
  return result.rowCount ? mapSchedule(result.rows[0]) : null;
}

export function resetWorkflowScheduleRepositoryForTests(): void {}
