import { randomUUID } from 'node:crypto';
import type {
  WorkflowScheduleInput,
  WorkflowScheduleLastStatus,
  WorkflowSchedulePatch,
  WorkflowScheduleRecord
} from '../types/workflows.js';

const workflowSchedules = new Map<string, WorkflowScheduleRecord>();

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function cloneSchedule(schedule: WorkflowScheduleRecord): WorkflowScheduleRecord {
  return {
    ...schedule,
    inputDefaults: { ...schedule.inputDefaults },
    approvedContextGrants: [...schedule.approvedContextGrants],
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

export function createWorkflowSchedule(params: {
  workspaceId: string;
  workflowVersion: number;
  input: WorkflowScheduleInput;
  actorUserId: string;
  now?: Date;
}): WorkflowScheduleRecord {
  const now = params.now || new Date();
  const createdAt = nowIso(now);
  const status = params.input.status || (params.input.enabled === false ? 'paused' : 'enabled');
  const schedule: WorkflowScheduleRecord = {
    id: randomUUID(),
    workspaceId: params.workspaceId,
    workflowId: params.input.workflowId,
    workflowVersion: params.workflowVersion,
    name: params.input.name.trim(),
    status,
    cron: params.input.cron.trim(),
    timezone: params.input.timezone.trim(),
    inputDefaults: params.input.inputDefaults || {},
    approvedContextGrants: [...new Set(params.input.approvedContextGrants || [])],
    createdBy: { userId: params.actorUserId },
    updatedBy: { userId: params.actorUserId },
    createdAt,
    updatedAt: createdAt,
    nextRunAt: status === 'enabled' ? computeNextWorkflowScheduleRunAt(params.input.cron, now, params.input.timezone.trim()) : undefined
  };
  workflowSchedules.set(schedule.id, schedule);
  return cloneSchedule(schedule);
}

export function listWorkflowSchedules(workspaceId: string): WorkflowScheduleRecord[] {
  return [...workflowSchedules.values()]
    .filter((schedule) => schedule.workspaceId === workspaceId)
    .sort((left, right) => (left.nextRunAt || '').localeCompare(right.nextRunAt || '') || left.name.localeCompare(right.name))
    .map(cloneSchedule);
}

export function getWorkflowSchedule(scheduleId: string): WorkflowScheduleRecord | null {
  const schedule = workflowSchedules.get(scheduleId);
  return schedule ? cloneSchedule(schedule) : null;
}

export function updateWorkflowScheduleRecord(
  scheduleId: string,
  patch: WorkflowSchedulePatch & { workflowVersion?: number },
  actorUserId: string,
  now = new Date()
): WorkflowScheduleRecord | null {
  const current = workflowSchedules.get(scheduleId);
  if (!current) return null;
  const cron = patch.cron?.trim() || current.cron;
  const timezone = patch.timezone?.trim() || current.timezone;
  const status = patch.status || (typeof patch.enabled === 'boolean' ? (patch.enabled ? 'enabled' : 'paused') : current.status);
  const updated: WorkflowScheduleRecord = {
    ...current,
    workflowId: patch.workflowId || current.workflowId,
    workflowVersion: patch.workflowVersion || current.workflowVersion,
    name: patch.name?.trim() || current.name,
    status,
    cron,
    timezone,
    inputDefaults: patch.inputDefaults || current.inputDefaults,
    approvedContextGrants: patch.approvedContextGrants ? [...new Set(patch.approvedContextGrants)] : current.approvedContextGrants,
    updatedBy: { userId: actorUserId },
    updatedAt: nowIso(now),
    nextRunAt: status === 'enabled' ? computeNextWorkflowScheduleRunAt(cron, now, timezone) : undefined
  };
  workflowSchedules.set(scheduleId, updated);
  return cloneSchedule(updated);
}

export function deleteWorkflowScheduleRecord(scheduleId: string): boolean {
  return workflowSchedules.delete(scheduleId);
}

export function listDueWorkflowSchedules(now = new Date(), limit = 50): WorkflowScheduleRecord[] {
  const nowTime = now.getTime();
  return [...workflowSchedules.values()]
    .filter((schedule) => schedule.status === 'enabled' && schedule.nextRunAt && new Date(schedule.nextRunAt).getTime() <= nowTime)
    .sort((left, right) => String(left.nextRunAt).localeCompare(String(right.nextRunAt)))
    .slice(0, Math.max(1, limit))
    .map(cloneSchedule);
}

export function recordWorkflowScheduleDispatch(
  scheduleId: string,
  status: WorkflowScheduleLastStatus,
  params: { now?: Date; error?: string } = {}
): WorkflowScheduleRecord | null {
  const current = workflowSchedules.get(scheduleId);
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
  workflowSchedules.set(scheduleId, updated);
  return cloneSchedule(updated);
}

export function resetWorkflowScheduleRepositoryForTests(): void {
  workflowSchedules.clear();
}
