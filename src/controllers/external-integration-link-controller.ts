import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createExternalIntegrationLink,
  completeExternalIntegrationLink,
  hashExternalIntegrationLinkToken
} from '../auth/external-integration-link.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { repo } from '../store/repository.js';
import type { ExternalIntegrationUserLinkSummary } from '../store/repository-external-integration-links.js';

const externalIntegrationIdentitySchema = z.object({
  externalUserId: z.string().trim().min(1).max(128),
  externalDisplayName: z.string().trim().min(1).max(120).optional()
}).strict();

const externalIntegrationUserUnlinkSchema = z.object({
  integrationClientId: z.string().trim().min(1).max(128),
  provider: z.string().trim().min(1).max(64),
  externalUserId: z.string().trim().min(1).max(128)
}).strict();

const externalIntegrationLinkTokenSchema = z.object({
  token: z.string().trim().min(1).max(256)
}).strict();

function rejectInvalidIdentity(res: Response): void {
  res.status(400).json({
    error: {
      code: 'INVALID_REQUEST',
      message: 'externalUserId is required as a bounded string',
      retryable: false
    }
  });
}

function externalIdentityObjectId(link: Pick<ExternalIntegrationUserLinkSummary, 'integrationClientId' | 'provider' | 'externalUserId'>): string {
  return `${link.integrationClientId}:${link.provider}:${link.externalUserId}`;
}

async function recordExternalIntegrationAudit(input: {
  userId?: string | null;
  actorType?: 'user' | 'system' | 'external_integration';
  actorUserId?: string | null;
  actorTokenId?: string | null;
  eventType: string;
  summary: string;
  link: Pick<ExternalIntegrationUserLinkSummary, 'id' | 'integrationClientId' | 'provider' | 'clientDisplayName' | 'externalUserId' | 'externalDisplayName'>;
}): Promise<void> {
  await repo.insertAccountAuditEvent({
    userId: input.userId,
    category: 'security',
    eventType: input.eventType,
    operation: 'write',
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    actorTokenId: input.actorTokenId,
    objectType: 'external_integration_link',
    objectId: input.link.id,
    objectName: externalIdentityObjectId(input.link),
    summary: input.summary,
    metadata: {
      integrationClientId: input.link.integrationClientId,
      provider: input.link.provider,
      clientDisplayName: input.link.clientDisplayName,
      externalUserId: input.link.externalUserId,
      externalDisplayName: input.link.externalDisplayName || null
    }
  });
}

export async function createExternalIntegrationLinkRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = req.externalIntegrationClient;
    if (!client) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'External integration client token required', retryable: false } });
      return;
    }
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const result = await createExternalIntegrationLink(client, parsed.data);
    await repo.insertAccountAuditEvent({
      category: 'security',
      eventType: 'external_integration.link.created.v1',
      operation: 'write',
      actorType: 'external_integration',
      actorTokenId: client.id,
      objectType: 'external_integration_link_token',
      objectName: `${client.id}:${client.provider}:${parsed.data.externalUserId}`,
      summary: 'External integration account link token created',
      metadata: {
        integrationClientId: client.id,
        provider: client.provider,
        clientDisplayName: client.displayName,
        externalUserId: parsed.data.externalUserId,
        externalDisplayName: parsed.data.externalDisplayName || null,
        expiresAt: result.expiresAt
      }
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function resolveExternalIntegrationLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = req.externalIntegrationClient;
    if (!client) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'External integration client token required', retryable: false } });
      return;
    }
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const resolution = await repo.resolveExternalIntegrationUserLink({
      integrationClientId: client.id,
      provider: client.provider,
      externalUserId: parsed.data.externalUserId
    });
    res.status(200).json(resolution || { status: 'unlinked' });
  } catch (err) {
    next(err);
  }
}

export async function previewExternalIntegrationLinkRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationLinkTokenSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'token is required as a bounded string', retryable: false }
      });
      return;
    }
    const user = await repo.getUserById(req.auth.userId);
    const preview = await repo.previewExternalIntegrationLinkToken(hashExternalIntegrationLinkToken(parsed.data.token));
    if (!user || !preview) {
      res.status(410).json({
        error: { code: 'EXTERNAL_INTEGRATION_LINK_EXPIRED', message: 'External integration link token is expired or unavailable', retryable: false }
      });
      return;
    }
    res.status(200).json({
      ...preview,
      signedInUser: {
        id: user.id,
        email: user.email,
        displayName: user.displayName
      }
    });
  } catch (err) {
    next(err);
  }
}

export async function completeExternalIntegrationLinkRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationLinkTokenSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'token is required as a bounded string', retryable: false }
      });
      return;
    }
    const user = await repo.getUserById(req.auth.userId);
    const link = user ? await completeExternalIntegrationLink(parsed.data.token, user) : null;
    if (!user || !link) {
      res.status(410).json({
        error: { code: 'EXTERNAL_INTEGRATION_LINK_EXPIRED', message: 'External integration link token is expired or unavailable', retryable: false }
      });
      return;
    }
    await recordExternalIntegrationAudit({
      userId: user.id,
      actorType: 'user',
      actorUserId: user.id,
      eventType: 'external_integration.link.completed.v1',
      summary: 'External integration account link completed',
      link
    });
    res.status(200).json({ status: 'linked', link });
  } catch (err) {
    next(err);
  }
}

export async function listExternalIntegrationLinks(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ links: await repo.listExternalIntegrationUserLinks(req.auth.userId) });
  } catch (err) {
    next(err);
  }
}

export async function unlinkExternalIntegrationLink(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationUserUnlinkSchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const result = await repo.revokeExternalIntegrationUserLink({
      integrationClientId: parsed.data.integrationClientId,
      provider: parsed.data.provider,
      externalUserId: parsed.data.externalUserId,
      acornopsUserId: req.auth.userId
    });
    if (result.status !== 'revoked' || !result.link) {
      res.status(404).json({ error: { code: 'EXTERNAL_INTEGRATION_LINK_NOT_FOUND', message: 'External integration link not found', retryable: false } });
      return;
    }
    await recordExternalIntegrationAudit({
      userId: req.auth.userId,
      actorType: 'user',
      actorUserId: req.auth.userId,
      eventType: 'external_integration.link.revoked.v1',
      summary: 'External integration account link revoked by user',
      link: result.link
    });
    res.status(200).json({ status: 'revoked', link: result.link });
  } catch (err) {
    next(err);
  }
}

export async function revokeExternalIntegrationLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = req.externalIntegrationClient;
    if (!client) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'External integration client token required', retryable: false } });
      return;
    }
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const result = await repo.revokeExternalIntegrationUserLink({
      integrationClientId: client.id,
      provider: client.provider,
      externalUserId: parsed.data.externalUserId
    });
    if (result.status !== 'revoked' || !result.link) {
      res.status(404).json({ error: { code: 'EXTERNAL_INTEGRATION_LINK_NOT_FOUND', message: 'External integration link not found', retryable: false } });
      return;
    }
    await recordExternalIntegrationAudit({
      userId: null,
      actorType: 'external_integration',
      actorTokenId: client.id,
      eventType: 'external_integration.link.revoked.v1',
      summary: 'External integration account link revoked by integration client',
      link: result.link
    });
    res.status(200).json({ status: 'revoked' });
  } catch (err) {
    next(err);
  }
}
