import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { config } from '../config.js';
import { repo } from '../store/repository.js';
import { WebhookHistory, WebhookSubscription } from '../types/domain.js';
import { encryptWebhookSecret, generateWebhookSecret } from '../utils/crypto.js';
import { toSingleParam } from '../utils/params.js';
import { canonicalizeWebhookUrl } from '../utils/webhook-url.js';

function serializeWebhook(subscription: WebhookSubscription): Record<string, unknown> {
  return {
    id: subscription.id,
    workspaceId: subscription.workspaceId,
    targetId: subscription.targetId || null,
    name: subscription.name,
    url: subscription.url,
    eventTypes: subscription.eventTypes,
    enabled: subscription.enabled,
    createdBy: subscription.createdBy,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt
  };
}

function serializeHistory(entry: WebhookHistory): Record<string, unknown> {
  return {
    id: entry.id,
    subscriptionId: entry.subscriptionId,
    eventId: entry.eventId,
    eventType: entry.eventType,
    workspaceId: entry.workspaceId,
    targetId: entry.targetId || null,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    payload: entry.payload,
    status: entry.status,
    responseStatus: entry.responseStatus ?? null,
    error: entry.error ?? null,
    durationMs: entry.durationMs ?? null,
    sentAt: entry.sentAt
  };
}

async function requireValidTargetScope(res: Response, workspaceId: string, targetId?: string | null): Promise<boolean> {
  if (!targetId) {
    return true;
  }
  const target = await repo.getTarget(workspaceId, targetId);
  if (target) {
    return true;
  }
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
  return false;
}

function parseHistoryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

export async function listWebhooks(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) {
      return;
    }

    const webhooks = await repo.listWebhookSubscriptions(workspaceId);
    res.status(200).json(webhooks.map(serializeWebhook));
  } catch (err) {
    next(err);
  }
}

export async function createWebhook(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_webhooks',
        'Only workspace roles with webhook management capability can modify webhooks'
      ))
    ) {
      return;
    }
    if (!(await requireValidTargetScope(res, workspaceId, req.body.targetId))) {
      return;
    }

    if (config.NODE_ENV === 'production' && !config.WEBHOOK_SECRET_ENCRYPTION_KEY) {
      res.status(500).json({
        error: {
          code: 'WEBHOOK_SECRET_ENCRYPTION_NOT_CONFIGURED',
          message: 'Webhook secret encryption is not configured',
          retryable: false
        }
      });
      return;
    }

    const secret = generateWebhookSecret();
    const subscription = await repo.createWebhookSubscription({
      workspaceId,
      targetId: req.body.targetId || null,
      name: req.body.name,
      url: canonicalizeWebhookUrl(req.body.url),
      eventTypes: req.body.eventTypes,
      enabled: req.body.enabled ?? true,
      secretCiphertext: encryptWebhookSecret(secret),
      secretKeyId: config.WEBHOOK_SECRET_KEY_ID,
      createdBy: req.auth.userId
    });

    res.status(201).json({
      ...serializeWebhook(subscription),
      secret
    });
  } catch (err) {
    next(err);
  }
}

export async function getWebhook(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const webhookId = toSingleParam(req.params.webhookId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) {
      return;
    }

    const webhook = await repo.getWebhookSubscription(workspaceId, webhookId);
    if (!webhook) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found', retryable: false } });
      return;
    }
    res.status(200).json(serializeWebhook(webhook));
  } catch (err) {
    next(err);
  }
}

export async function updateWebhook(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const webhookId = toSingleParam(req.params.webhookId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_webhooks',
        'Only workspace roles with webhook management capability can modify webhooks'
      ))
    ) {
      return;
    }
    if (!(await requireValidTargetScope(res, workspaceId, req.body.targetId))) {
      return;
    }

    const patch: {
      name?: string;
      url?: string;
      eventTypes?: string[];
      targetId?: string | null;
      enabled?: boolean;
    } = {
      name: req.body.name,
      url: req.body.url ? canonicalizeWebhookUrl(req.body.url) : undefined,
      eventTypes: req.body.eventTypes,
      enabled: req.body.enabled
    };
    if (Object.prototype.hasOwnProperty.call(req.body, 'targetId')) {
      patch.targetId = req.body.targetId || null;
    }

    const updated = await repo.updateWebhookSubscription(workspaceId, webhookId, patch);
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found', retryable: false } });
      return;
    }

    res.status(200).json(serializeWebhook(updated));
  } catch (err) {
    next(err);
  }
}

export async function deleteWebhook(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const webhookId = toSingleParam(req.params.webhookId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_webhooks',
        'Only workspace roles with webhook management capability can modify webhooks'
      ))
    ) {
      return;
    }

    const deleted = await repo.deleteWebhookSubscription(workspaceId, webhookId);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found', retryable: false } });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function listWebhookHistory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const webhookId = toSingleParam(req.params.webhookId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_webhooks',
        'Only workspace roles with webhook management capability can read webhook delivery history'
      ))
    ) {
      return;
    }

    const webhook = await repo.getWebhookSubscription(workspaceId, webhookId);
    if (!webhook) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found', retryable: false } });
      return;
    }

    const history = await repo.listWebhookHistory(workspaceId, webhookId, {
      limit: parseHistoryLimit(req.query.limit)
    });
    res.status(200).json(history.map(serializeHistory));
  } catch (err) {
    next(err);
  }
}
