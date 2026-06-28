import { NextFunction, Response } from 'express';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { incrementApprovalInboxQuery } from '../metrics.js';
import { repo } from '../store/repository.js';
import {
  createWorkflowSchedule,
  deleteWorkflowScheduleRecord,
  getWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowScheduleRecord,
  validateWorkflowScheduleCron,
  validateWorkflowScheduleTimezone
} from '../store/repository-workflow-schedules.js';
import {
  getWorkflowDefinition,
  listWorkflowApprovalsForWorkspace
} from '../store/repository-workflows.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import type { RunToolApproval } from '../types/domain.js';
import type { WorkflowApprovalInboxRow, WorkflowScheduleRecord } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';

function objectBody(req: AuthenticatedRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scheduleSummary(items: WorkflowScheduleRecord[]) {
  return {
    total: items.length,
    active: items.filter((item) => item.status === 'enabled').length,
    paused: items.filter((item) => item.status === 'paused').length,
    approvalGated: items.filter((item) => {
      const workflow = getWorkflowDefinition(item.workspaceId, item.workflowId);
      return Boolean(workflow?.policy.approvalRequirements.length || workflow?.steps.some((step) => step.approvalRequired));
    }).length,
    nextRunAt: items
      .filter((item) => item.status === 'enabled' && item.nextRunAt)
      .map((item) => item.nextRunAt as string)
      .sort()[0]
  };
}

function validateScheduleInput(body: Record<string, unknown>, partial = false): { ok: true } | { ok: false; code: string; message: string } {
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const cron = typeof body.cron === 'string' ? body.cron.trim() : '';
  const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  if (!partial && !workflowId) return { ok: false, code: 'WORKFLOW_REQUIRED', message: 'workflowId is required.' };
  if (!partial && !name) return { ok: false, code: 'SCHEDULE_NAME_REQUIRED', message: 'Schedule name is required.' };
  if (!partial && !cron) return { ok: false, code: 'SCHEDULE_CRON_REQUIRED', message: 'Cron expression is required.' };
  if (!partial && !timezone) return { ok: false, code: 'SCHEDULE_TIMEZONE_REQUIRED', message: 'Timezone is required.' };
  if (cron && !validateWorkflowScheduleCron(cron)) return { ok: false, code: 'INVALID_CRON', message: 'Cron expression must use five valid fields.' };
  if (timezone && !validateWorkflowScheduleTimezone(timezone)) return { ok: false, code: 'INVALID_TIMEZONE', message: 'Timezone is not recognized.' };
  return { ok: true };
}

export async function listWorkspaceWorkflowSchedules(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to workflow schedules'))) return;
    const items = listWorkflowSchedules(workspaceId);
    res.status(200).json({ items, summary: scheduleSummary(items) });
  } catch (err) {
    next(err);
  }
}

export async function createWorkflowScheduleForWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can create schedules'
    );
    if (!authz) return;
    const body = objectBody(req);
    const validation = validateScheduleInput(body);
    if (!validation.ok) {
      res.status(400).json({ error: { code: validation.code, message: validation.message, retryable: false } });
      return;
    }
    const workflow = getWorkflowDefinition(workspaceId, String(body.workflowId));
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const schedule = createWorkflowSchedule({
      workspaceId,
      workflowVersion: workflow.version,
      actorUserId: req.auth.userId,
      input: {
        workflowId: workflow.id,
        name: String(body.name),
        enabled: body.enabled !== false,
        cron: String(body.cron),
        timezone: String(body.timezone),
        inputDefaults: objectValue(body.inputDefaults),
        approvedContextGrants: stringList(body.approvedContextGrants)
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'workflow.schedule_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow_schedule',
      objectId: schedule.id,
      objectName: schedule.name,
      summary: 'Workflow schedule created',
      metadata: { workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, status: schedule.status }
    });
    res.status(201).json({ schedule });
  } catch (err) {
    next(err);
  }
}

export async function updateWorkflowSchedule(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const scheduleId = toSingleParam(req.params.scheduleId);
    const current = getWorkflowSchedule(scheduleId);
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Schedule not found', retryable: false } });
      return;
    }
    const body = objectBody(req);
    const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : current.workspaceId;
    if (workspaceId !== current.workspaceId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Schedule not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceCapability(
      req,
      res,
      current.workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can update schedules'
    );
    if (!authz) return;
    const validation = validateScheduleInput(body, true);
    if (!validation.ok) {
      res.status(400).json({ error: { code: validation.code, message: validation.message, retryable: false } });
      return;
    }
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : current.workflowId;
    const workflow = getWorkflowDefinition(current.workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const updated = updateWorkflowScheduleRecord(
      scheduleId,
      {
        workflowId,
        workflowVersion: workflow.version,
        name: typeof body.name === 'string' ? body.name : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        status: body.status === 'enabled' || body.status === 'paused' ? body.status : undefined,
        cron: typeof body.cron === 'string' ? body.cron : undefined,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        inputDefaults: body.inputDefaults === undefined ? undefined : objectValue(body.inputDefaults),
        approvedContextGrants: body.approvedContextGrants === undefined ? undefined : stringList(body.approvedContextGrants)
      },
      req.auth.userId
    );
    await recordWorkspaceAuditEvent({
      workspaceId: current.workspaceId,
      category: 'run',
      eventType: 'workflow.schedule_updated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow_schedule',
      objectId: scheduleId,
      objectName: updated?.name || current.name,
      summary: 'Workflow schedule updated',
      metadata: { workflowId, status: updated?.status }
    });
    res.status(200).json({ schedule: updated });
  } catch (err) {
    next(err);
  }
}

export async function deleteWorkflowSchedule(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const scheduleId = toSingleParam(req.params.scheduleId);
    const current = getWorkflowSchedule(scheduleId);
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Schedule not found', retryable: false } });
      return;
    }
    const body = objectBody(req);
    const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : current.workspaceId;
    if (workspaceId !== current.workspaceId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Schedule not found', retryable: false } });
      return;
    }
    if (!(await requireWorkspaceCapability(req, res, current.workspaceId, 'manage_workflows', 'Only workspace roles with workflow management capability can delete schedules'))) return;
    deleteWorkflowScheduleRecord(scheduleId);
    await recordWorkspaceAuditEvent({
      workspaceId: current.workspaceId,
      category: 'run',
      eventType: 'workflow.schedule_deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow_schedule',
      objectId: scheduleId,
      objectName: current.name,
      summary: 'Workflow schedule deleted',
      metadata: { workflowId: current.workflowId }
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

function targetApprovalInboxRow(approval: RunToolApproval): WorkflowApprovalInboxRow {
  return {
    approvalId: approval.id,
    runId: approval.runId,
    source: 'target_tool',
    targetId: approval.targetId,
    targetType: approval.targetType,
    summary: approval.summary || `Run ${approval.toolName}`,
    toolName: approval.toolName,
    requestedBy: approval.requestedBy,
    expiresAt: approval.expiresAt,
    status: approval.status,
    decision: approval.decision,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt,
    requestedAt: approval.createdAt
  };
}

export async function listWorkspaceApprovalInbox(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to approvals'))) return;
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status = rawStatus === 'decided' || rawStatus === 'all' ? rawStatus : 'pending';
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    incrementApprovalInboxQuery(status);
    const targetApprovals = await repo.listWorkspaceRunToolApprovals({ workspaceId, status, limit, cursor });
    const workflowApprovals = collectWorkflowApprovalInboxRows(workspaceId, status);
    const items = [...targetApprovals.map(targetApprovalInboxRow), ...workflowApprovals]
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .slice(0, limit);
    res.status(200).json({
      items,
      nextCursor: items.length === limit ? items[items.length - 1]?.requestedAt : undefined
    });
  } catch (err) {
    next(err);
  }
}

function collectWorkflowApprovalInboxRows(workspaceId: string, status: 'pending' | 'decided' | 'all'): WorkflowApprovalInboxRow[] {
  return listWorkflowApprovalsForWorkspace(workspaceId, status).map((approval) => ({
    approvalId: approval.id,
    runId: approval.runId,
    source: 'workflow_gate',
    workflowId: approval.workflowId,
    summary: approval.summary,
    toolName: approval.toolName,
    requestedBy: approval.requestedBy,
    expiresAt: approval.expiresAt,
    status: approval.status,
    decision: approval.decision,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt,
    requestedAt: approval.createdAt
  }));
}
