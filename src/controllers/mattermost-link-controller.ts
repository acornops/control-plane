import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createMattermostLink,
  completeMattermostLink
} from '../auth/mattermost-link.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { repo } from '../store/repository.js';

const mattermostIdentitySchema = z.object({
  mattermostUserId: z.string().trim().min(1).max(128)
});

const mattermostLinkCompletionSchema = z.object({
  token: z.string().trim().min(1).max(256)
});

function rejectInvalidIdentity(res: Response): void {
  res.status(400).json({
    error: {
      code: 'INVALID_REQUEST',
      message: 'mattermostUserId is required as a bounded string',
      retryable: false
    }
  });
}

export async function createMattermostLinkRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = mattermostIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    res.status(200).json(await createMattermostLink(parsed.data));
  } catch (err) {
    next(err);
  }
}

export async function resolveMattermostLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = mattermostIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const resolution = await repo.resolveMattermostUserLink(parsed.data);
    res.status(200).json(resolution || { status: 'unlinked' });
  } catch (err) {
    next(err);
  }
}

export async function completeMattermostLinkRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = mattermostLinkCompletionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'token is required as a bounded string', retryable: false }
      });
      return;
    }
    const user = await repo.getUserById(req.auth.userId);
    if (!user || !await completeMattermostLink(parsed.data.token, user)) {
      res.status(410).json({
        error: { code: 'MATTERMOST_LINK_EXPIRED', message: 'Mattermost link token is expired or unavailable', retryable: false }
      });
      return;
    }
    res.status(200).json({ status: 'linked' });
  } catch (err) {
    next(err);
  }
}
