import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { toSingleParam } from '../utils/params.js';

export async function requirePublicAgentRoute(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceParam = toSingleParam(req.params.workspaceId);
    const workspaceInput = req.body?.workspaceId || req.query.workspaceId;
    const workspaceId = workspaceParam || (typeof workspaceInput === 'string' ? workspaceInput.trim() : '');
    const agentId = toSingleParam(req.params.agentId);
    if (!workspaceId || !agentId) {
      next();
      return;
    }
    await getAgentDefinition(workspaceId, agentId);
    next();
  } catch (error) {
    next(error);
  }
}
