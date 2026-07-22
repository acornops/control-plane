import { createHash } from 'node:crypto';
import { NextFunction, Response } from 'express';
import { getWorkspacePermissions, listConfiguredRoleTemplates } from '../auth/authorization.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  incrementExternalWebhookRouteRequest,
  incrementExternalWebhookRouteSecretRotations
} from '../metrics-external-webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import type { ExternalRouteWebhookSubscription } from '../store/repository-webhooks.js';
import { webhookRouteConnectSchema } from '../types/contracts.js';
import { encryptWebhookSecret, generateWebhookSecret } from '../utils/crypto.js';
import { canonicalizeWebhookUrl, WebhookUrlValidationError } from '../utils/webhook-url.js';

type RouteStatus = 'unconfigured' | 'configured' | 'connected';

interface ExternalRouteIdentity {
  externalIntegrationUserLinkId: string;
  integrationClientId: string;
  provider: string;
  externalUserId: string;
  acornopsUserId: string;
}

function externalRouteIdentity(req: AuthenticatedRequest): ExternalRouteIdentity | null {
  const credential = req.auth.credential;
  if (credential.type !== 'external_integration') {
    return null;
  }
  return {
    externalIntegrationUserLinkId: credential.linkId,
    integrationClientId: credential.integrationId,
    provider: credential.provider,
    externalUserId: credential.externalUserId,
    acornopsUserId: req.auth.userId
  };
}

function rejectInvalidDeliveryUrl(res: Response, message = 'deliveryUrl must be a valid HTTPS webhook URL without credentials'): void {
  res.status(400).json({
    error: {
      code: 'INVALID_WEBHOOK_ROUTE',
      message,
      retryable: false
    }
  });
}

function serializeSubscription(
  subscription: ExternalRouteWebhookSubscription,
  signingSecret?: string
): Record<string, unknown> {
  return {
    workspaceId: subscription.workspaceId,
    workspaceName: subscription.workspaceName,
    webhookId: subscription.id,
    name: subscription.name,
    targetId: subscription.targetId || null,
    eventTypes: subscription.eventTypes,
    enabled: subscription.enabled,
    status: subscription.enabled ? 'enabled' : 'disabled',
    updatedAt: subscription.updatedAt,
    ...(signingSecret ? { signingSecret } : {})
  };
}

async function listManageableSubscriptions(identity: ExternalRouteIdentity, deliveryUrl: string): Promise<ExternalRouteWebhookSubscription[]> {
  const subscriptions = await repo.listWebhookSubscriptionsForExternalRoute({
    acornopsUserId: identity.acornopsUserId,
    deliveryUrl
  });
  return subscriptions.filter((subscription) => getWorkspacePermissions(subscription.workspaceRole).manage_webhooks);
}

function routeResponse(input: {
  status: RouteStatus;
  connectedAt?: string | null;
  lastSyncedAt?: string | null;
  subscriptions: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    status: input.status,
    connectedAt: input.connectedAt ?? null,
    lastSyncedAt: input.lastSyncedAt ?? null,
    subscriptions: input.subscriptions
  };
}

function hashDeliveryUrl(deliveryUrl: string): string {
  return createHash('sha256').update(deliveryUrl).digest('hex');
}

export async function connectExternalWebhookRoute(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const identity = externalRouteIdentity(req);
    if (!identity) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Linked external integration required', retryable: false } });
      return;
    }
    const parsed = webhookRouteConnectSchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidDeliveryUrl(res);
      return;
    }
    const deliveryUrl = canonicalizeWebhookUrl(parsed.data.deliveryUrl);
    const subscriptions = await listManageableSubscriptions(identity, deliveryUrl);
    if (subscriptions.length === 0) {
      incrementExternalWebhookRouteRequest('connect', 'unconfigured');
      res.status(200).json(routeResponse({ status: 'unconfigured', subscriptions: [] }));
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

    const preparedRotations = subscriptions.map((subscription) => {
      const signingSecret = generateWebhookSecret();
      return {
        subscription,
        signingSecret,
        rotation: {
          workspaceId: subscription.workspaceId,
          webhookId: subscription.id,
          secretCiphertext: encryptWebhookSecret(signingSecret),
          secretKeyId: config.WEBHOOK_SECRET_KEY_ID
        }
      };
    });
    const connected = await repo.connectExternalWebhookRoute({
      externalIntegrationUserLinkId: identity.externalIntegrationUserLinkId,
      integrationClientId: identity.integrationClientId,
      provider: identity.provider,
      externalUserId: identity.externalUserId,
      acornopsUserId: identity.acornopsUserId,
      deliveryUrl,
      allowedRoleKeys: listConfiguredRoleTemplates()
        .filter((role) => role.capabilities.includes('manage_webhooks'))
        .map((role) => role.key),
      rotations: preparedRotations.map((item) => item.rotation)
    });
    const updatedById = new Map(connected.subscriptions.map((subscription) => [subscription.id, subscription]));
    const rotated = await Promise.all(preparedRotations.map(async ({ subscription, signingSecret }) => {
      const updated = updatedById.get(subscription.id);
      if (!updated) {
        throw new Error(`Failed rotating webhook secret for ${subscription.id}`);
      }
      const effectiveSubscription: ExternalRouteWebhookSubscription = {
        ...subscription,
        ...updated,
        workspaceName: subscription.workspaceName,
        workspaceRole: subscription.workspaceRole
      };
      await recordWorkspaceAuditEvent({
        workspaceId: subscription.workspaceId,
        category: 'workspace',
        eventType: 'webhook.route.connected.v1',
        operation: 'write',
        actorType: 'external_integration',
        actorUserId: identity.acornopsUserId,
        actorTokenId: identity.integrationClientId,
        objectType: 'webhook_subscription',
        objectId: subscription.id,
        objectName: subscription.name,
        summary: 'Webhook signing secret rotated by external route connect',
        metadata: {
          integrationClientId: identity.integrationClientId,
          provider: identity.provider,
          externalUserId: identity.externalUserId,
          deliveryUrlHash: hashDeliveryUrl(deliveryUrl),
          webhookId: subscription.id
        }
      });
      return { subscription: effectiveSubscription, signingSecret };
    }));

    incrementExternalWebhookRouteRequest('connect', 'connected');
    incrementExternalWebhookRouteSecretRotations(identity.integrationClientId, rotated.length);
    logger.info(
      {
        integrationClientId: identity.integrationClientId,
        provider: identity.provider,
        externalUserId: identity.externalUserId,
        subscriptionCount: rotated.length
      },
      'External webhook route connected'
    );
    res.status(200).json(routeResponse({
      status: 'connected',
      connectedAt: connected.connection.connectedAt,
      lastSyncedAt: connected.connection.lastSyncedAt,
      subscriptions: rotated.map((item) => serializeSubscription(item.subscription, item.signingSecret))
    }));
  } catch (err) {
    next(err);
  }
}

export async function getExternalWebhookRouteStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const identity = externalRouteIdentity(req);
    if (!identity) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Linked external integration required', retryable: false } });
      return;
    }
    const rawDeliveryUrl = typeof req.query.deliveryUrl === 'string' ? req.query.deliveryUrl : '';
    let deliveryUrl: string;
    try {
      deliveryUrl = canonicalizeWebhookUrl(rawDeliveryUrl);
    } catch (err) {
      rejectInvalidDeliveryUrl(res, err instanceof WebhookUrlValidationError ? err.message : undefined);
      return;
    }

    const subscriptions = await listManageableSubscriptions(identity, deliveryUrl);
    if (subscriptions.length === 0) {
      incrementExternalWebhookRouteRequest('status', 'unconfigured');
      res.status(200).json(routeResponse({ status: 'unconfigured', subscriptions: [] }));
      return;
    }

    const connection = await repo.touchExternalWebhookRouteConnection({
      externalIntegrationUserLinkId: identity.externalIntegrationUserLinkId,
      integrationClientId: identity.integrationClientId,
      provider: identity.provider,
      externalUserId: identity.externalUserId,
      deliveryUrl
    });
    const status: RouteStatus = connection ? 'connected' : 'configured';
    incrementExternalWebhookRouteRequest('status', status);
    res.status(200).json(routeResponse({
      status,
      connectedAt: connection?.connectedAt,
      lastSyncedAt: connection?.lastSyncedAt,
      subscriptions: subscriptions.map((subscription) => serializeSubscription(subscription))
    }));
  } catch (err) {
    next(err);
  }
}
