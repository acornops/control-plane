import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireWorkspaceDataRead } from '../../auth/workspace-authorization.js';
import { repo } from '../../store/repository.js';
import { isTargetType, TARGET_TYPE_DISPLAY_LIST, TargetType } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../../utils/pagination.js';

export async function listTargets(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) {
      return;
    }

    const q = normalizeSearchQuery(req.query.q);
    const rawTargetType = toSingleParam(req.query.targetType as string | string[] | undefined);
    let targetType: TargetType | undefined;
    if (rawTargetType) {
      if (!isTargetType(rawTargetType)) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `targetType must be one of: ${TARGET_TYPE_DISPLAY_LIST}`,
            retryable: false
          }
        });
        return;
      }
      targetType = rawTargetType;
    }
    const filters = { q, targetType };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ createdAt: string; targetId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listTargets(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      q,
      targetType,
      signature
    });
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) {
      return;
    }

    const target = await repo.getTarget(workspaceId, targetId);
    if (!target) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
      return;
    }
    res.status(200).json(target);
  } catch (err) {
    next(err);
  }
}
