import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { config } from '../config.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  createWorkflowWebhook,
  deleteWorkflowWebhookRecord,
  getWorkflowWebhook,
  listWorkflowWebhooks,
  rotateWorkflowWebhookSecret,
  updateWorkflowWebhookRecord
} from '../store/repository-workflow-webhooks.js';
import {
  getWorkflowExecutionSummary,
  listWorkflowExecutionSummariesByIds
} from '../store/repository-workflow-activity.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import type { WorkflowWebhookRecord } from '../types/workflows.js';
import { encryptWebhookSecret, generateWebhookSecret } from '../utils/crypto.js';
import { toSingleParam } from '../utils/params.js';
import {
  publicWorkflowWebhook,
  workflowWebhookEndpointUrl
} from './workflow-webhook-public.js';
import {
  WORKFLOW_WEBHOOK_CREATE_FIELDS,
  WORKFLOW_WEBHOOK_UPDATE_FIELDS,
  WORKFLOW_WEBHOOK_WORKSPACE_FIELDS,
  unexpectedBodyField
} from './workflow-webhook-validation.js';

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

async function auditWebhook(
  webhook: WorkflowWebhookRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: webhook.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorUserId,
    objectType: 'workflow_webhook',
    objectId: webhook.id,
    objectName: webhook.name,
    summary,
    metadata: {
      workflowId: webhook.workflowId,
      status: webhook.status,
      ...metadata
    }
  });
}

function webhookNotFound(res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Workflow webhook not found',
      retryable: false
    }
  });
}

function signingSecretResponse(webhookId: string, secret: string): Record<string, string> {
  return {
    url: workflowWebhookEndpointUrl(webhookId),
    secret,
    secretDisclosure: 'one_time'
  };
}

export async function listWorkspaceWorkflowWebhooks(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to workflow webhooks'))) return;
    const items = await listWorkflowWebhooks(workspaceId);
    const executions = await listWorkflowExecutionSummariesByIds(
      items.flatMap((item) => item.lastExecutionId ? [item.lastExecutionId] : [])
    );
    res.status(200).json({
      items: items.map((item) => publicWorkflowWebhook(
        item,
        item.lastExecutionId ? executions.get(item.lastExecutionId) || null : null
      ))
    });
  } catch (error) {
    next(error);
  }
}

export async function createWorkspaceWorkflowWebhook(
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
      'Only workspace roles with workflow management capability can create workflow webhooks'
    ))) return;
    const body = objectBody(req);
    const unexpectedField = unexpectedBodyField(body, WORKFLOW_WEBHOOK_CREATE_FIELDS);
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (
      unexpectedField
      || !workflowId
      || !name
      || name.length > 120
      || (body.enabled !== undefined && typeof body.enabled !== 'boolean')
    ) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_WEBHOOK_INVALID',
        message: unexpectedField
          ? `${unexpectedField} is not supported.`
          : 'workflowId, a name of at most 120 characters, and an optional boolean enabled value are required.',
        retryable: false
      } });
      return;
    }
    const workflow = await getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    if (body.enabled !== false && workflow.status !== 'active') {
      res.status(409).json({ error: {
        code: 'WORKFLOW_NOT_ACTIVE',
        message: 'Activate the workflow before enabling a workflow webhook.',
        retryable: false
      } });
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
    const webhook = await createWorkflowWebhook({
      workspaceId,
      actorUserId: req.auth.userId,
      input: {
        workflowId,
        name,
        enabled: body.enabled !== false,
        principal: { type: 'user', id: req.auth.userId }
      },
      secretCiphertext: encryptWebhookSecret(secret),
      secretKeyId: config.WEBHOOK_SECRET_KEY_ID
    });
    await auditWebhook(webhook, req.auth.userId, 'workflow.webhook_created.v1', 'Workflow webhook created');
    res.status(201).json({
      webhook: publicWorkflowWebhook(webhook),
      signingSecret: signingSecretResponse(webhook.id, secret)
    });
  } catch (error) {
    next(error);
  }
}

export async function updateWorkflowWebhook(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const webhookId = toSingleParam(req.params.webhookId);
    const body = objectBody(req);
    const workspaceId = mutationWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can update workflow webhooks'
    ))) return;
    const unexpectedField = unexpectedBodyField(body, WORKFLOW_WEBHOOK_UPDATE_FIELDS);
    if (
      unexpectedField
      || (body.enabled !== undefined && typeof body.enabled !== 'boolean')
      || (body.name !== undefined && typeof body.name !== 'string')
    ) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_WEBHOOK_INVALID',
        message: unexpectedField
          ? `${unexpectedField} is not supported.`
          : 'name must be a string and enabled must be a boolean.',
        retryable: false
      } });
      return;
    }
    const current = await getWorkflowWebhook(webhookId);
    if (!current || current.workspaceId !== workspaceId) {
      webhookNotFound(res);
      return;
    }
    const workflow = await getWorkflowDefinition(current.workspaceId, current.workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    if (body.enabled === true && workflow.status !== 'active') {
      res.status(409).json({ error: {
        code: 'WORKFLOW_NOT_ACTIVE',
        message: 'Activate the workflow before enabling this workflow webhook.',
        retryable: false
      } });
      return;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (name !== undefined && (!name || name.length > 120)) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_WEBHOOK_NAME_INVALID',
        message: 'Workflow webhook name must be between 1 and 120 characters.',
        retryable: false
      } });
      return;
    }
    const updated = await updateWorkflowWebhookRecord(
      webhookId,
      {
        name,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined
      },
      req.auth.userId
    );
    if (!updated) {
      webhookNotFound(res);
      return;
    }
    await auditWebhook(updated, req.auth.userId, 'workflow.webhook_updated.v1', 'Workflow webhook updated');
    const latestExecution = updated.lastExecutionId
      ? await getWorkflowExecutionSummary(updated.lastExecutionId)
      : null;
    res.status(200).json({ webhook: publicWorkflowWebhook(updated, latestExecution) });
  } catch (error) {
    next(error);
  }
}

export async function rotateWorkflowWebhookSigningSecret(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const webhookId = toSingleParam(req.params.webhookId);
    const workspaceId = mutationWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can rotate workflow webhook secrets'
    ))) return;
    const unexpectedField = unexpectedBodyField(objectBody(req), WORKFLOW_WEBHOOK_WORKSPACE_FIELDS);
    if (unexpectedField) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_WEBHOOK_INVALID',
        message: `${unexpectedField} is not supported.`,
        retryable: false
      } });
      return;
    }
    const current = await getWorkflowWebhook(webhookId);
    if (!current || current.workspaceId !== workspaceId) {
      webhookNotFound(res);
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
    const updated = await rotateWorkflowWebhookSecret(
      webhookId,
      encryptWebhookSecret(secret),
      config.WEBHOOK_SECRET_KEY_ID,
      req.auth.userId
    );
    if (!updated) {
      webhookNotFound(res);
      return;
    }
    await auditWebhook(
      updated,
      req.auth.userId,
      'workflow.webhook_secret_rotated.v1',
      'Workflow webhook signing secret rotated'
    );
    res.status(200).json({
      webhook: publicWorkflowWebhook(
        updated,
        updated.lastExecutionId
          ? await getWorkflowExecutionSummary(updated.lastExecutionId)
          : null
      ),
      signingSecret: signingSecretResponse(updated.id, secret)
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteWorkflowWebhook(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const webhookId = toSingleParam(req.params.webhookId);
    const workspaceId = mutationWorkspaceId(req, res);
    if (!workspaceId) return;
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_workflows',
      'Only workspace roles with workflow management capability can delete workflow webhooks'
    ))) return;
    const unexpectedField = unexpectedBodyField(objectBody(req), WORKFLOW_WEBHOOK_WORKSPACE_FIELDS);
    if (unexpectedField) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_WEBHOOK_INVALID',
        message: `${unexpectedField} is not supported.`,
        retryable: false
      } });
      return;
    }
    const current = await getWorkflowWebhook(webhookId);
    if (!current || current.workspaceId !== workspaceId) {
      webhookNotFound(res);
      return;
    }
    await deleteWorkflowWebhookRecord(webhookId);
    await auditWebhook(current, req.auth.userId, 'workflow.webhook_deleted.v1', 'Workflow webhook deleted');
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export {
  constantTimeSignatureEqual,
  receiveWorkflowWebhook
} from './workflow-webhook-ingress-controller.js';
