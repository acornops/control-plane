import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability } from '../auth/workspace-authorization.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  createAgentTrigger as createStoredAgentTrigger,
  deleteAgentTrigger as deleteStoredAgentTrigger,
  getAgentDefinition,
  updateAgentTrigger as updateStoredAgentTrigger
} from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import { encryptWebhookSecret, generateWebhookSecret } from '../utils/crypto.js';
import { toSingleParam } from '../utils/params.js';
import { validateWorkflowScheduleCron, validateWorkflowScheduleTimezone } from '../store/repository-workflow-schedules.js';
import { badRequest, bodyRecord, triggerType } from './agent-controller-helpers.js';

function workspaceId(req: AuthenticatedRequest, res: Response): string | null {
  const value = req.body?.workspaceId || req.query.workspaceId;
  if (typeof value === 'string' && value.trim()) return value.trim();
  badRequest(res, 'AGENT_WORKSPACE_REQUIRED', 'workspaceId is required for workspace-scoped agent routes.');
  return null;
}

async function audit(req: AuthenticatedRequest, agent: AgentDefinition, eventType: string, summary: string, metadata: Record<string, unknown>): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: agent.workspaceId, category: 'run', eventType, operation: 'write', actorUserId: req.auth.userId,
    objectType: 'agent', objectId: agent.id, objectName: agent.name, summary,
    metadata: { agentId: agent.id, agentVersion: agent.version, status: agent.status, ...metadata }
  });
}

export async function createAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = workspaceId(req, res);
    if (!scope || !(await requireWorkspaceCapability(req, res, scope, 'manage_agents', 'No permission to manage agent triggers'))) return;
    const body = bodyRecord(req.body);
    const type = triggerType(body.type);
    if (!type) return badRequest(res, 'AGENT_TRIGGER_TYPE_UNSUPPORTED', 'Supported trigger types are manual, workflow_step, schedule, webhook, and target_event.');
    const webhookSecret = type === 'webhook' ? generateWebhookSecret() : undefined;
    const schedule = body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
      ? body.schedule as { cron: string; timezone: string } : undefined;
    if (type === 'schedule' && (!schedule || !validateWorkflowScheduleCron(schedule.cron) || !validateWorkflowScheduleTimezone(schedule.timezone))) {
      return badRequest(res, 'AGENT_TRIGGER_SCHEDULE_INVALID', 'Schedule triggers require a valid five-field cron and IANA timezone.');
    }
    const agentId = toSingleParam(req.params.agentId);
    const trigger = await createStoredAgentTrigger(scope, agentId, {
      type, enabled: body.enabled !== false, name: typeof body.name === 'string' ? body.name : undefined,
      schedule,
      eventFilter: body.eventFilter && typeof body.eventFilter === 'object' && !Array.isArray(body.eventFilter) ? body.eventFilter as Record<string, unknown> : undefined,
      secretCiphertext: webhookSecret ? encryptWebhookSecret(webhookSecret) : undefined
    });
    if (!trigger) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
    const agent = await getAgentDefinition(scope, agentId);
    if (agent) await audit(req, agent, 'agent.trigger_created.v1', 'Agent trigger created', { triggerId: trigger.id, triggerType: trigger.type, triggerEnabled: trigger.enabled });
    res.status(201).json({ trigger, ...(webhookSecret ? { webhook: {
      url: `${req.protocol}://${req.get('host')}/api/v1/automation/webhooks/${trigger.id}`,
      secret: webhookSecret, secretDisclosure: 'one_time'
    } } : {}) });
  } catch (err) { next(err); }
}

export async function updateAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = workspaceId(req, res);
    if (!scope || !(await requireWorkspaceCapability(req, res, scope, 'manage_agents', 'No permission to manage agent triggers'))) return;
    const body = bodyRecord(req.body);
    const type = body.type === undefined ? undefined : triggerType(body.type);
    if (body.type !== undefined && !type) return badRequest(res, 'AGENT_TRIGGER_TYPE_UNSUPPORTED', 'Supported trigger types are manual, workflow_step, schedule, webhook, and target_event.');
    const agentId = toSingleParam(req.params.agentId);
    const trigger = await updateStoredAgentTrigger(scope, agentId, toSingleParam(req.params.triggerId), {
      type: type || undefined, enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      schedule: body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule) ? body.schedule as { cron: string; timezone: string } : undefined,
      eventFilter: body.eventFilter && typeof body.eventFilter === 'object' && !Array.isArray(body.eventFilter) ? body.eventFilter as Record<string, unknown> : undefined
    });
    if (!trigger) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent trigger not found', retryable: false } });
    const agent = await getAgentDefinition(scope, agentId);
    if (agent) await audit(req, agent, 'agent.trigger_updated.v1', 'Agent trigger updated', { triggerId: trigger.id, triggerType: trigger.type, triggerEnabled: trigger.enabled });
    res.status(200).json({ trigger });
  } catch (err) { next(err); }
}

export async function deleteAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = workspaceId(req, res);
    if (!scope || !(await requireWorkspaceCapability(req, res, scope, 'manage_agents', 'No permission to manage agent triggers'))) return;
    const agentId = toSingleParam(req.params.agentId);
    const triggerId = toSingleParam(req.params.triggerId);
    if (!(await deleteStoredAgentTrigger(scope, agentId, triggerId))) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent trigger not found', retryable: false } });
    const agent = await getAgentDefinition(scope, agentId);
    if (agent) await audit(req, agent, 'agent.trigger_deleted.v1', 'Agent trigger deleted', { triggerId });
    res.status(204).send();
  } catch (err) { next(err); }
}
