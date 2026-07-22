import { NextFunction, Response } from 'express';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import {
  incrementApprovalInboxQuery,
  observeApprovalInboxQueryDurationMs,
  observeWorkflowSchedulePreviewDurationMs
} from '../metrics.js';
import { repo } from '../store/repository.js';
import {
  createWorkflowSchedule,
  computeUpcomingWorkflowScheduleRuns,
  deleteWorkflowScheduleRecord,
  getWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowScheduleRecord,
  summarizeWorkflowScheduleCron,
  validateWorkflowScheduleCron,
  validateWorkflowScheduleTimezone
} from '../store/repository-workflow-schedules.js';
import {
  getWorkflowDefinition,
  listWorkflowApprovalsForWorkspace
} from '../store/repository-workflows.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import type { RunToolApproval } from '../types/domain.js';
import type { WorkflowApprovalInboxResponse, WorkflowApprovalInboxRow, WorkflowScheduleRecord } from '../types/workflows.js';
import { resolveRunPrincipal } from '../services/run-principal.js';
import type { WorkflowSchedulePrincipal } from '../types/workflows.js';
import {
  countPendingWorkspaceAutomationApprovals,
  listWorkspaceAutomationApprovals,
  type AutomationRunApproval
} from '../store/repository-automation-approvals.js';
import { toSingleParam } from '../utils/params.js';
import { promptResourceRegistry } from '../services/prompt-resources/index.js';
import { getWorkflowScheduleMcpReadinessReport } from '../services/workflow-schedule-readiness.js';
import { publicMcpReadinessError } from '../services/workflow-readiness.js';
import { WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { respondWorkflowAccessError } from './workflow-public.js';

function objectBody(req: AuthenticatedRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

export async function previewWorkflowSchedule(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can preview schedules'
    );
    if (!authz) return;
    const body = objectBody(req);
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
    const cron = typeof body.cron === 'string' ? body.cron.trim() : '';
    const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
    const controlMessage = typeof body.controlMessage === 'string' ? body.controlMessage : '';
    const approvedContextGrants = stringList(body.approvedContextGrants);
    const errors: Array<{ field: string; message: string }> = [];
    const principal = principalRef(body.principal);
    if (!principal || principal.id !== req.auth.userId) {
      errors.push({ field: 'principal', message: 'Schedules must run as the authenticated creator.' });
    }
    const runtimeSubject = principal && principal.id === req.auth.userId
      ? await resolveRunPrincipal(workspaceId, principal)
      : null;
    if (principal && principal.id === req.auth.userId && !runtimeSubject) {
      errors.push({ field: 'principal', message: 'Your schedule identity is not active or authorized in this workspace.' });
    }
    const workflow = workflowId ? await getWorkflowDefinition(workspaceId, workflowId) : null;
    if (!workflowId) errors.push({ field: 'workflowId', message: 'Choose a workflow.' });
    else if (!workflow) errors.push({ field: 'workflowId', message: 'Workflow was not found in this workspace.' });
    if (!cron) errors.push({ field: 'cron', message: 'Choose a frequency or enter a cron expression.' });
    else if (!validateWorkflowScheduleCron(cron)) errors.push({ field: 'cron', message: 'Use a valid five-field cron expression.' });
    if (!timezone) errors.push({ field: 'timezone', message: 'Choose a timezone.' });
    else if (!validateWorkflowScheduleTimezone(timezone)) errors.push({ field: 'timezone', message: 'Choose a recognized IANA timezone.' });
    let resolution: Awaited<ReturnType<typeof promptResourceRegistry.resolve>> | undefined;
    if (workflow) {
      if (!controlMessage.trim()) errors.push({ field: 'controlMessage', message: 'Enter the control message to resolve for each occurrence.' });
      else {
        resolution = await promptResourceRegistry.resolve(controlMessage, {
          workspaceId,
          actorUserId: req.auth.userId,
          workflowId: workflow.id,
          source: 'trigger',
          mode: 'launch',
          requirements: workflow.resourceRequirements || []
        });
        resolution.blockers.forEach((blocker) => errors.push({ field: 'controlMessage', message: blocker.message }));
      }
      const allowedGrants = new Set(workflow.capabilityPolicy.contextGrants);
      for (const grant of approvedContextGrants) {
        if (!allowedGrants.has(grant)) errors.push({ field: 'approvedContextGrants', message: `Context grant ${grant} is not used by this workflow.` });
      }
    }
    if (body.enabled !== false && workflow && principal && runtimeSubject && resolution && resolution.blockers.length === 0 && errors.length === 0) {
      try {
        const readiness = await getWorkflowScheduleMcpReadinessReport({
          workspaceId,
          workflow,
          actor: runtimeSubject,
          principal,
          approvedContextGrants,
          resolution
        });
        if (readiness.errors.length > 0) {
          errors.push({
            field: 'mcpReadiness',
            message: readiness.errors.slice(0, 3).join(' ')
          });
        }
      } catch (error) {
        if (!(error instanceof WorkflowAccessDeniedError)) throw error;
        errors.push({ field: 'readiness', message: error.message });
      }
    }
    const valid = errors.length === 0;
    const nextRunTimes = valid ? computeUpcomingWorkflowScheduleRuns(cron, timezone, 5) : [];
    observeWorkflowSchedulePreviewDurationMs(valid ? 'valid' : 'invalid', Date.now() - startedAt);
    res.status(200).json({
      valid,
      summary: valid ? summarizeWorkflowScheduleCron(cron, timezone) : 'Complete the highlighted fields to preview this schedule.',
      nextRunTimes,
      errors
    });
  } catch (err) {
    observeWorkflowSchedulePreviewDurationMs('error', Date.now() - startedAt);
    if (err instanceof WorkflowAccessDeniedError) {
      respondWorkflowAccessError(res, err);
      return;
    }
    next(err);
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function principalRef(value: unknown): WorkflowSchedulePrincipal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const principal = value as Record<string, unknown>;
  if (principal.type !== 'user' || typeof principal.id !== 'string' || !principal.id.trim()) return undefined;
  return { type: 'user', id: principal.id.trim() };
}

async function scheduleSummary(items: WorkflowScheduleRecord[]) {
  const workflowBySchedule = new Map(await Promise.all(items.map(async (item) => [
    item.id,
    await getWorkflowDefinition(item.workspaceId, item.workflowId)
  ] as const)));
  return {
    total: items.length,
    active: items.filter((item) => item.status === 'enabled').length,
    paused: items.filter((item) => item.status === 'paused').length,
    approvalGated: items.filter((item) => {
      const workflow = workflowBySchedule.get(item.id);
      return Boolean(workflow?.capabilityPolicy.approvalRequirements.length);
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
  const controlMessage = typeof body.controlMessage === 'string' ? body.controlMessage : '';
  if (!partial && !workflowId) return { ok: false, code: 'WORKFLOW_REQUIRED', message: 'workflowId is required.' };
  if (!partial && !name) return { ok: false, code: 'SCHEDULE_NAME_REQUIRED', message: 'Schedule name is required.' };
  if (!partial && !cron) return { ok: false, code: 'SCHEDULE_CRON_REQUIRED', message: 'Cron expression is required.' };
  if (!partial && !timezone) return { ok: false, code: 'SCHEDULE_TIMEZONE_REQUIRED', message: 'Timezone is required.' };
  if (!partial && !controlMessage.trim()) return { ok: false, code: 'SCHEDULE_CONTROL_MESSAGE_REQUIRED', message: 'Control message is required.' };
  if (cron && !validateWorkflowScheduleCron(cron)) return { ok: false, code: 'INVALID_CRON', message: 'Cron expression must use five valid fields.' };
  if (timezone && !validateWorkflowScheduleTimezone(timezone)) return { ok: false, code: 'INVALID_TIMEZONE', message: 'Timezone is not recognized.' };
  return { ok: true };
}

export async function listWorkspaceWorkflowSchedules(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to workflow schedules'))) return;
    const items = await listWorkflowSchedules(workspaceId);
    res.status(200).json({ items, summary: await scheduleSummary(items) });
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
    const principal = principalRef(body.principal);
    if (!principal || principal.id !== req.auth.userId) {
      res.status(400).json({ error: { code: 'WORKFLOW_SCHEDULE_USER_PRINCIPAL_REQUIRED', message: 'Workflow schedules must run as the authenticated creator.', retryable: false } });
      return;
    }
    const runtimeSubject = await resolveRunPrincipal(workspaceId, principal);
    if (!runtimeSubject) {
      res.status(403).json({ error: { code: 'WORKFLOW_SCHEDULE_PRINCIPAL_INVALID', message: 'The delegated principal is not active or authorized in this workspace.', retryable: false } });
      return;
    }
    const workflow = await getWorkflowDefinition(workspaceId, String(body.workflowId));
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const resolution = await promptResourceRegistry.resolve(String(body.controlMessage), {
      workspaceId,
      actorUserId: principal.id,
      workflowId: workflow.id,
      source: 'trigger',
      mode: 'launch',
      requirements: workflow.resourceRequirements || []
    });
    if (resolution.blockers.length > 0) {
      res.status(400).json({ error: { code: resolution.blockers[0].code, message: resolution.blockers[0].message, retryable: resolution.blockers[0].retryable } });
      return;
    }
    if (body.enabled !== false) {
      const readiness = await getWorkflowScheduleMcpReadinessReport({
        workspaceId,
        workflow,
        actor: runtimeSubject,
        principal,
        approvedContextGrants: stringList(body.approvedContextGrants),
        resolution
      });
      if (readiness.errors.length > 0) {
        res.status(409).json({ error: publicMcpReadinessError(readiness) });
        return;
      }
    }
    const schedule = await createWorkflowSchedule({
      workspaceId,
      workflowVersion: workflow.version,
      actorUserId: req.auth.userId,
      input: {
        workflowId: workflow.id,
        name: String(body.name),
        enabled: body.enabled !== false,
        cron: String(body.cron),
        timezone: String(body.timezone),
        controlMessage: String(body.controlMessage),
        approvedContextGrants: stringList(body.approvedContextGrants),
        principal
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
    if (err instanceof WorkflowAccessDeniedError) {
      respondWorkflowAccessError(res, err);
      return;
    }
    next(err);
  }
}

export async function updateWorkflowSchedule(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const scheduleId = toSingleParam(req.params.scheduleId);
    const current = await getWorkflowSchedule(scheduleId);
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
    const workflow = await getWorkflowDefinition(current.workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const requestedPrincipal = body.principal === undefined ? undefined : principalRef(body.principal);
    if (body.principal !== undefined && (!requestedPrincipal || requestedPrincipal.id !== req.auth.userId)) {
      res.status(400).json({ error: { code: 'WORKFLOW_SCHEDULE_USER_PRINCIPAL_REQUIRED', message: 'Workflow schedules must use the authenticated user principal.', retryable: false } });
      return;
    }
    const principal = requestedPrincipal || current.principal;
    const runtimeSubject = await resolveRunPrincipal(current.workspaceId, principal);
    if (!runtimeSubject) {
      res.status(403).json({ error: { code: 'WORKFLOW_SCHEDULE_PRINCIPAL_INVALID', message: 'The schedule user is not active or authorized in this workspace.', retryable: false } });
      return;
    }
    const controlMessage = typeof body.controlMessage === 'string' ? body.controlMessage : current.controlMessage;
    const resolution = await promptResourceRegistry.resolve(controlMessage, {
      workspaceId: current.workspaceId,
      actorUserId: principal.id,
      workflowId: workflow.id,
      source: 'trigger',
      mode: 'launch',
      requirements: workflow.resourceRequirements || []
    });
    if (resolution.blockers.length > 0) {
      res.status(400).json({ error: { code: resolution.blockers[0].code, message: resolution.blockers[0].message, retryable: resolution.blockers[0].retryable } });
      return;
    }
    const nextStatus = body.status === 'enabled' || body.status === 'paused'
      ? body.status
      : typeof body.enabled === 'boolean'
        ? body.enabled ? 'enabled' : 'paused'
        : current.status;
    if (nextStatus === 'enabled') {
      const readiness = await getWorkflowScheduleMcpReadinessReport({
        workspaceId: current.workspaceId,
        workflow,
        actor: runtimeSubject,
        principal,
        approvedContextGrants: body.approvedContextGrants === undefined
          ? current.approvedContextGrants
          : stringList(body.approvedContextGrants),
        resolution
      });
      if (readiness.errors.length > 0) {
        res.status(409).json({ error: publicMcpReadinessError(readiness) });
        return;
      }
    }
    const updated = await updateWorkflowScheduleRecord(
      scheduleId,
      {
        workflowId,
        workflowVersion: workflow.version,
        name: typeof body.name === 'string' ? body.name : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        status: body.status === 'enabled' || body.status === 'paused' ? body.status : undefined,
        cron: typeof body.cron === 'string' ? body.cron : undefined,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        controlMessage: typeof body.controlMessage === 'string' ? body.controlMessage : undefined,
        approvedContextGrants: body.approvedContextGrants === undefined ? undefined : stringList(body.approvedContextGrants),
        principal
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
    if (err instanceof WorkflowAccessDeniedError) {
      respondWorkflowAccessError(res, err);
      return;
    }
    next(err);
  }
}

export async function deleteWorkflowSchedule(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const scheduleId = toSingleParam(req.params.scheduleId);
    const current = await getWorkflowSchedule(scheduleId);
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
    await deleteWorkflowScheduleRecord(scheduleId);
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

function automationApprovalInboxRow(approval: AutomationRunApproval): WorkflowApprovalInboxRow {
  return {
    approvalId: approval.id,
    runId: approval.runId,
    source: approval.sourceType === 'agent'
      ? approval.approvalKind === 'pre_step' ? 'agent_gate' : 'agent_tool'
      : 'workflow_tool',
    targetId: approval.targetId,
    targetType: approval.targetType,
    summary: approval.summary,
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
  const startedAt = Date.now();
  const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const status = rawStatus === 'decided' || rawStatus === 'all' ? rawStatus : 'pending';
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to approvals'))) {
      incrementApprovalInboxQuery(status, 'denied');
      observeApprovalInboxQueryDurationMs(status, 'denied', Date.now() - startedAt);
      return;
    }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const runId = typeof req.query.runId === 'string' && req.query.runId.trim() ? req.query.runId.trim() : undefined;
    const approvalId = typeof req.query.approvalId === 'string' && req.query.approvalId.trim() ? req.query.approvalId.trim() : undefined;
    const [targetApprovals, pendingTargetCount, automationApprovals, pendingAutomationCount] = await Promise.all([
      repo.listWorkspaceRunToolApprovals({
        workspaceId,
        status,
        limit,
        cursor,
        ...(runId ? { runId } : {}),
        ...(approvalId ? { approvalId } : {})
      }),
      repo.countPendingWorkspaceRunToolApprovals(workspaceId),
      listWorkspaceAutomationApprovals({ workspaceId, status, limit, cursor }),
      countPendingWorkspaceAutomationApprovals(workspaceId)
    ]);
    const workflowApprovals = await collectWorkflowApprovalInboxRows(workspaceId, status, { runId, approvalId });
    const pendingWorkflowCount = (await listWorkflowApprovalsForWorkspace(workspaceId, 'pending')).length;
    const items = [...targetApprovals.map(targetApprovalInboxRow), ...workflowApprovals, ...automationApprovals.map(automationApprovalInboxRow)]
      .filter((approval) => {
        if (runId && approval.runId !== runId) return false;
        if (approvalId && approval.approvalId !== approvalId) return false;
        return true;
      })
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .slice(0, limit);
    incrementApprovalInboxQuery(status, 'success');
    observeApprovalInboxQueryDurationMs(status, 'success', Date.now() - startedAt);
    const response: WorkflowApprovalInboxResponse = {
      items,
      pendingCount: pendingTargetCount + pendingWorkflowCount + pendingAutomationCount,
      ...(items.length === limit && items[items.length - 1]?.requestedAt
        ? { nextCursor: items[items.length - 1].requestedAt }
        : {})
    };
    res.status(200).json(response);
  } catch (err) {
    incrementApprovalInboxQuery(status, 'error');
    observeApprovalInboxQueryDurationMs(status, 'error', Date.now() - startedAt);
    next(err);
  }
}

async function collectWorkflowApprovalInboxRows(
  workspaceId: string,
  status: 'pending' | 'decided' | 'all',
  filters: { runId?: string; approvalId?: string } = {}
): Promise<WorkflowApprovalInboxRow[]> {
  return (await listWorkflowApprovalsForWorkspace(workspaceId, status)).map((approval) => ({
    approvalId: approval.id,
    runId: approval.runId,
    source: 'workflow_gate' as const,
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
  })).filter((approval) => {
    if (filters.runId && approval.runId !== filters.runId) return false;
    if (filters.approvalId && approval.approvalId !== filters.approvalId) return false;
    return true;
  });
}
