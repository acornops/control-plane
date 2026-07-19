import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { repo } from '../store/repository.js';
import { toSingleParam } from '../utils/params.js';
import { CursorMismatchError, decodeCursor, makeQuerySignature, parseBoundedLimit } from '../utils/pagination.js';
import { auditAdmin, notFound } from './admin-controller-common.js';

export async function listWorkspaceMembers(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await repo.getAdminWorkspace(workspaceId))) {
      notFound(res, 'Workspace not found');
      return;
    }
    const signature = makeQuerySignature({ workspaceId });
    const cursor = decodeCursor<{ createdAt: string; userId: string; signature: string }>(req.query.cursor, signature);
    const result = await repo.listAdminWorkspaceMembers({
      workspaceId,
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      signature
    });
    await auditAdmin(req, { action: 'admin.workspace.members.search', workspaceId, metadata: { highRiskRead: true } });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}
