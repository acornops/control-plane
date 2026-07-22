import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { AgentNativeToolAssignmentError, setAgentNativeToolAssignment } from '../services/agent-native-tools.js';
import { listWorkspaceNativeTools } from '../services/workspace-native-tools.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { toSingleParam } from '../utils/params.js';
import { agentResponse } from './agent-controller-helpers.js';

export async function listNativeTools(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json({ items: listWorkspaceNativeTools() });
  } catch (error) { next(error); }
}

async function mutate(req: AuthenticatedRequest, res: Response, next: NextFunction, assigned: boolean): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage Agent tools'))) return;
    const agentId = toSingleParam(req.params.agentId);
    const current = await getAgentDefinition(workspaceId, agentId);
    if (!current || current.kind === 'manager') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const agent = await setAgentNativeToolAssignment({
      workspaceId,
      agentId,
      toolId: toSingleParam(req.params.toolId),
      assigned,
      actorUserId: req.auth.userId
    });
    res.status(200).json({ agent: await agentResponse(agent) });
  } catch (error) {
    if (error instanceof AgentNativeToolAssignmentError) {
      res.status(error.code.endsWith('NOT_FOUND') ? 404 : 409).json({
        error: { code: error.code, message: error.message, retryable: false }
      });
      return;
    }
    next(error);
  }
}

export async function grantNativeTool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return mutate(req, res, next, true);
}

export async function revokeNativeTool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return mutate(req, res, next, false);
}
