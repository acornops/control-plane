import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { getMemberWorkspaceAccessState, listMemberWorkspaceAccessStates } from '../store/repository-workspace-access-state.js';

export async function getWorkspaceAccessState(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const state = await getMemberWorkspaceAccessState(req.auth.userId, String(req.params.workspaceId));
    res.setHeader('Cache-Control', 'no-store');
    if (!state) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found', retryable: false } }); return; }
    res.json(state);
  } catch (error) { next(error); }
}
export async function listWorkspaceAccessStates(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: await listMemberWorkspaceAccessStates(req.auth.userId) });
  } catch (error) { next(error); }
}
