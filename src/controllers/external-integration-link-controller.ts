import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createExternalIntegrationLink,
  completeExternalIntegrationLink
} from '../auth/external-integration-link.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { repo } from '../store/repository.js';

const externalIntegrationIdentitySchema = z.object({
  externalUserId: z.string().trim().min(1).max(128)
});

const externalIntegrationLinkCompletionSchema = z.object({
  token: z.string().trim().min(1).max(256)
});

function rejectInvalidIdentity(res: Response): void {
  res.status(400).json({
    error: {
      code: 'INVALID_REQUEST',
      message: 'externalUserId is required as a bounded string',
      retryable: false
    }
  });
}

export async function createExternalIntegrationLinkRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    res.status(200).json(await createExternalIntegrationLink(parsed.data));
  } catch (err) {
    next(err);
  }
}

export async function resolveExternalIntegrationLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const resolution = await repo.resolveExternalIntegrationUserLink(parsed.data);
    res.status(200).json(resolution || { status: 'unlinked' });
  } catch (err) {
    next(err);
  }
}

export async function completeExternalIntegrationLinkRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationLinkCompletionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'token is required as a bounded string', retryable: false }
      });
      return;
    }
    const user = await repo.getUserById(req.auth.userId);
    if (!user || !await completeExternalIntegrationLink(parsed.data.token, user)) {
      res.status(410).json({
        error: { code: 'EXTERNAL_INTEGRATION_LINK_EXPIRED', message: 'External integration link token is expired or unavailable', retryable: false }
      });
      return;
    }
    res.status(200).json({ status: 'linked' });
  } catch (err) {
    next(err);
  }
}
