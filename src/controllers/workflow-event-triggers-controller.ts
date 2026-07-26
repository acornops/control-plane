import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { config } from '../config.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  createWorkflowEventTrigger,
  deleteWorkflowEventTriggerRecord,
  getWorkflowEventTrigger,
  listWorkflowEventTriggers,
  rotateWorkflowEventTriggerSecret,
  updateWorkflowEventTriggerRecord
} from '../store/repository-workflow-event-triggers.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import {
  getWorkflowExecutionSummary,
  listWorkflowExecutionSummariesByIds
} from '../store/repository-workflow-activity.js';
import type {
  WorkflowEventTriggerRecord
} from '../types/workflows.js';
import { encryptWebhookSecret, generateWebhookSecret } from '../utils/crypto.js';
import { toSingleParam } from '../utils/params.js';
import { workflowParameterSignature } from '../services/workflow-template.js';
import {
  EVENT_TRIGGER_CREATE_FIELDS,
  EVENT_TRIGGER_UPDATE_FIELDS,
  EVENT_TRIGGER_WORKSPACE_FIELDS,
  parseContextGrantList,
  parseEventInputBindings,
  unexpectedBodyField,
  validateEventTriggerContextGrants,
  validateIssueBindings
} from './workflow-event-trigger-validation.js';
import {
  publicWorkflowEventTrigger,
  workflowEventTriggerEndpointUrl
} from './workflow-event-trigger-public.js';

function objectBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function mutationWorkspaceId(req: Request, res: Response): string | null {
  const value = objectBody(req).workspaceId;
  if (typeof value === 'string' && value.trim()) return value.trim();
  res.status(400).json({ error: {
    code: 'WORKSPACE_ID_REQUIRED',
    message: 'workspaceId is required.',
    retryable: false
  } });
  return null;
}

async function auditTrigger(
  trigger: WorkflowEventTriggerRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: trigger.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorUserId,
    objectType: 'workflow_event_trigger',
    objectId: trigger.id,
    objectName: trigger.name,
    summary,
    metadata: {
      workflowId: trigger.workflowId,
      sourceType: trigger.sourceType,
      sourceEventType: trigger.eventType,
      status: trigger.status,
      ...metadata
    }
  });
}

export async function listWorkspaceWorkflowEventTriggers(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to workflow event triggers'))) return;
    const items = await listWorkflowEventTriggers(workspaceId);
    const executions = await listWorkflowExecutionSummariesByIds(
      items.flatMap((item) => item.lastExecutionId ? [item.lastExecutionId] : [])
    );
    res.status(200).json({
      items: items.map((item) => publicWorkflowEventTrigger(
        item,
        item.lastExecutionId ? executions.get(item.lastExecutionId) || null : null
      ))
    });
  } catch (error) {
    next(error);
  }
}

export async function createWorkspaceWorkflowEventTrigger(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can create event triggers'
    ))) return;
    const body = objectBody(req);
    const unexpectedField = unexpectedBodyField(body, EVENT_TRIGGER_CREATE_FIELDS);
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sourceType = body.sourceType === 'webhook' || body.sourceType === 'acornops_event'
      ? body.sourceType
      : undefined;
    if (
      unexpectedField
      || !workflowId
      || !name
      || name.length > 120
      || !sourceType
      || (body.enabled !== undefined && typeof body.enabled !== 'boolean')
    ) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_TRIGGER_INVALID',
        message: unexpectedField
          ? `${unexpectedField} is not supported.`
          : 'workflowId, a name of at most 120 characters, a boolean enabled value, and a supported sourceType are required.',
        retryable: false
      } });
      return;
    }
    const eventType = sourceType === 'acornops_event' && body.eventType === 'issue.created.v1'
      ? body.eventType
      : undefined;
    if (sourceType === 'acornops_event' && !eventType) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_TYPE_UNSUPPORTED',
        message: 'The supported AcornOps event type is issue.created.v1.',
        retryable: false
      } });
      return;
    }
    if (sourceType === 'webhook' && body.eventType !== undefined) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_TYPE_UNSUPPORTED',
        message: 'Webhook event triggers do not accept an AcornOps event type.',
        retryable: false
      } });
      return;
    }
    const principal = { type: 'user' as const, id: req.auth.userId };
    const workflow = await getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    if (body.enabled !== false && workflow.status !== 'active') {
      res.status(409).json({ error: {
        code: 'WORKFLOW_NOT_ACTIVE',
        message: 'Activate the workflow before enabling an event trigger.',
        retryable: false
      } });
      return;
    }
    const bindings = body.inputBindings === undefined
      ? {}
      : parseEventInputBindings(body.inputBindings);
    if (sourceType === 'acornops_event' && !bindings) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_INPUT_BINDINGS_INVALID',
        message: 'Issue event input bindings are invalid.',
        retryable: false
      } });
      return;
    }
    if (sourceType === 'webhook' && (!bindings || Object.keys(bindings).length > 0)) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_INPUT_BINDINGS_INVALID',
        message: 'Webhook event triggers do not use issue-field input bindings.',
        retryable: false
      } });
      return;
    }
    const bindingError = sourceType === 'acornops_event'
      ? validateIssueBindings(workflow.parameters, bindings || {})
      : null;
    if (bindingError) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_INPUT_BINDINGS_INVALID',
        message: bindingError,
        retryable: false
      } });
      return;
    }
    if (sourceType === 'webhook' && config.NODE_ENV === 'production' && !config.WEBHOOK_SECRET_ENCRYPTION_KEY) {
      res.status(500).json({ error: {
        code: 'WEBHOOK_SECRET_ENCRYPTION_NOT_CONFIGURED',
        message: 'Webhook secret encryption is not configured.',
        retryable: false
      } });
      return;
    }
    const approvedContextGrants = parseContextGrantList(body.approvedContextGrants);
    if (!approvedContextGrants) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_CONTEXT_GRANTS_INVALID',
        message: 'approvedContextGrants must contain unique, non-empty strings.',
        retryable: false
      } });
      return;
    }
    const grantError = validateEventTriggerContextGrants(
      workflow.capabilityPolicy.contextGrants,
      approvedContextGrants
    );
    if (grantError) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_CONTEXT_GRANTS_INVALID',
        message: grantError,
        retryable: false
      } });
      return;
    }
    const secret = sourceType === 'webhook' ? generateWebhookSecret() : undefined;
    const trigger = await createWorkflowEventTrigger({
      workspaceId,
      workflowVersion: workflow.version,
      parameterSignature: workflowParameterSignature(workflow.parameters),
      actorUserId: req.auth.userId,
      input: {
        workflowId,
        name,
        enabled: body.enabled !== false,
        sourceType,
        eventType,
        inputBindings: bindings || {},
        approvedContextGrants,
        principal
      },
      secretCiphertext: secret ? encryptWebhookSecret(secret) : undefined,
      secretKeyId: secret ? config.WEBHOOK_SECRET_KEY_ID : undefined
    });
    await auditTrigger(trigger, req.auth.userId, 'workflow.event_trigger_created.v1', 'Workflow event trigger created');
    res.status(201).json({
      trigger: publicWorkflowEventTrigger(trigger),
      ...(secret ? {
        webhook: {
          url: workflowEventTriggerEndpointUrl(trigger.id),
          secret,
          secretDisclosure: 'one_time'
        }
      } : {})
    });
  } catch (error) {
    next(error);
  }
}

export async function updateWorkflowEventTrigger(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const triggerId = toSingleParam(req.params.triggerId);
    const body = objectBody(req);
    const workspaceId = mutationWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can update event triggers'
    ))) return;
    const unexpectedField = unexpectedBodyField(body, EVENT_TRIGGER_UPDATE_FIELDS);
    if (
      unexpectedField
      || (body.enabled !== undefined && typeof body.enabled !== 'boolean')
      || (body.name !== undefined && typeof body.name !== 'string')
    ) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_TRIGGER_INVALID',
        message: unexpectedField
          ? `${unexpectedField} is not supported.`
          : 'name must be a string and enabled must be a boolean.',
        retryable: false
      } });
      return;
    }
    const current = await getWorkflowEventTrigger(triggerId);
    if (!current || current.workspaceId !== workspaceId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event trigger not found', retryable: false } });
      return;
    }
    const workflow = await getWorkflowDefinition(current.workspaceId, current.workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const enabling = body.enabled === true;
    if (enabling && workflow.status !== 'active') {
      res.status(409).json({ error: {
        code: 'WORKFLOW_NOT_ACTIVE',
        message: 'Activate the workflow before enabling this event trigger.',
        retryable: false
      } });
      return;
    }
    const bindings = body.inputBindings === undefined
      ? current.inputBindings
      : parseEventInputBindings(body.inputBindings);
    if (!bindings) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_INPUT_BINDINGS_INVALID',
        message: 'Event input bindings are invalid.',
        retryable: false
      } });
      return;
    }
    if (current.sourceType === 'webhook' && Object.keys(bindings).length > 0) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_INPUT_BINDINGS_INVALID',
        message: 'Webhook event triggers do not use issue-field input bindings.',
        retryable: false
      } });
      return;
    }
    const bindingError = current.sourceType === 'acornops_event'
      ? validateIssueBindings(workflow.parameters, bindings)
      : null;
    if (bindingError) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_INPUT_BINDINGS_INVALID',
        message: bindingError,
        retryable: false
      } });
      return;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (name !== undefined && (!name || name.length > 120)) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_TRIGGER_NAME_INVALID',
        message: 'Event trigger name must be between 1 and 120 characters.',
        retryable: false
      } });
      return;
    }
    const approvedContextGrants = body.approvedContextGrants === undefined
      ? current.approvedContextGrants
      : parseContextGrantList(body.approvedContextGrants);
    if (!approvedContextGrants) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_CONTEXT_GRANTS_INVALID',
        message: 'approvedContextGrants must contain unique, non-empty strings.',
        retryable: false
      } });
      return;
    }
    const grantError = validateEventTriggerContextGrants(
      workflow.capabilityPolicy.contextGrants,
      approvedContextGrants
    );
    if (grantError) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_CONTEXT_GRANTS_INVALID',
        message: grantError,
        retryable: false
      } });
      return;
    }
    const updated = await updateWorkflowEventTriggerRecord(
      triggerId,
      {
        workflowVersion: workflow.version,
        parameterSignature: workflowParameterSignature(workflow.parameters),
        name,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        inputBindings: bindings,
        approvedContextGrants
      },
      req.auth.userId
    );
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event trigger not found', retryable: false } });
      return;
    }
    await auditTrigger(updated, req.auth.userId, 'workflow.event_trigger_updated.v1', 'Workflow event trigger updated');
    const latestExecution = updated.lastExecutionId
      ? await getWorkflowExecutionSummary(updated.lastExecutionId)
      : null;
    res.status(200).json({ trigger: publicWorkflowEventTrigger(updated, latestExecution) });
  } catch (error) {
    next(error);
  }
}

export async function rotateWorkflowEventTriggerSigningSecret(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const triggerId = toSingleParam(req.params.triggerId);
    const workspaceId = mutationWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can rotate trigger secrets'
    ))) return;
    const unexpectedField = unexpectedBodyField(objectBody(req), EVENT_TRIGGER_WORKSPACE_FIELDS);
    if (unexpectedField) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_TRIGGER_INVALID',
        message: `${unexpectedField} is not supported.`,
        retryable: false
      } });
      return;
    }
    const current = await getWorkflowEventTrigger(triggerId);
    if (!current || current.workspaceId !== workspaceId || current.sourceType !== 'webhook') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook event trigger not found', retryable: false } });
      return;
    }
    if (config.NODE_ENV === 'production' && !config.WEBHOOK_SECRET_ENCRYPTION_KEY) {
      res.status(500).json({ error: {
        code: 'WEBHOOK_SECRET_ENCRYPTION_NOT_CONFIGURED',
        message: 'Webhook secret encryption is not configured.',
        retryable: false
      } });
      return;
    }
    const secret = generateWebhookSecret();
    const updated = await rotateWorkflowEventTriggerSecret(
      triggerId,
      encryptWebhookSecret(secret),
      config.WEBHOOK_SECRET_KEY_ID,
      req.auth.userId
    );
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook event trigger not found', retryable: false } });
      return;
    }
    await auditTrigger(
      updated,
      req.auth.userId,
      'workflow.event_trigger_secret_rotated.v1',
      'Workflow event trigger signing secret rotated'
    );
    res.status(200).json({
      trigger: publicWorkflowEventTrigger(
        updated,
        updated.lastExecutionId
          ? await getWorkflowExecutionSummary(updated.lastExecutionId)
          : null
      ),
      webhook: {
        url: workflowEventTriggerEndpointUrl(updated.id),
        secret,
        secretDisclosure: 'one_time'
      }
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteWorkflowEventTrigger(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const triggerId = toSingleParam(req.params.triggerId);
    const workspaceId = mutationWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can delete event triggers'
    ))) return;
    const unexpectedField = unexpectedBodyField(objectBody(req), EVENT_TRIGGER_WORKSPACE_FIELDS);
    if (unexpectedField) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_EVENT_TRIGGER_INVALID',
        message: `${unexpectedField} is not supported.`,
        retryable: false
      } });
      return;
    }
    const current = await getWorkflowEventTrigger(triggerId);
    if (!current || current.workspaceId !== workspaceId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event trigger not found', retryable: false } });
      return;
    }
    await deleteWorkflowEventTriggerRecord(triggerId);
    await auditTrigger(current, req.auth.userId, 'workflow.event_trigger_deleted.v1', 'Workflow event trigger deleted');
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export {
  constantTimeSignatureEqual,
  receiveWorkflowEventTriggerWebhook,
  validateWebhookInputs,
  webhookInputsValid
} from './workflow-event-trigger-webhook-controller.js';
export {
  validateEventTriggerContextGrants,
  validateIssueBindings
} from './workflow-event-trigger-validation.js';
