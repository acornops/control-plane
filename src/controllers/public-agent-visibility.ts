import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import { toSingleParam } from '../utils/params.js';

export function isInternalTemplateManager(
  agent: Pick<AgentDefinition, 'kind'>
): boolean {
  return agent.kind === 'manager';
}

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
    const agent = await getAgentDefinition(workspaceId, agentId);
    if (agent?.kind === 'manager') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
