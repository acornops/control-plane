import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { AgentNativeToolAssignmentError, setAgentNativeToolAssignment } from '../services/agent-native-tools.js';
import { listWorkspaceNativeToolsForInvocationScope } from '../services/workspace-native-tools.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import {
  listTemplateInstallations,
  templateRecordReferencesById
} from '../store/repository-automation-templates.js';
import { toSingleParam } from '../utils/params.js';
import { agentResponse } from './agent-controller-helpers.js';

export async function listNativeTools(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const items = listWorkspaceNativeToolsForInvocationScope('agent_chat').map((tool) => ({
      ...tool,
      invocationScopes: tool.invocationScopes.filter((scope) => scope !== 'target_chat')
    }));
    res.status(200).json({ items });
  } catch (error) { next(error); }
}

async function mutate(req: AuthenticatedRequest, res: Response, next: NextFunction, assigned: boolean): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage Agent tools'))) return;
    const agentId = toSingleParam(req.params.agentId);
    const current = await getAgentDefinition(workspaceId, agentId);
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    if (assigned && req.body !== undefined) {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).some((key) => key !== 'config')) {
        res.status(400).json({
          error: {
            code: 'NATIVE_TOOL_CONFIG_INVALID',
            message: 'Native-tool assignment accepts only an optional config object.',
            retryable: false
          }
        });
        return;
      }
    }
    const agent = await setAgentNativeToolAssignment({
      workspaceId,
      agentId,
      toolId: toSingleParam(req.params.toolId),
      assigned,
      actorUserId: req.auth.userId,
      config: assigned ? req.body?.config : undefined
    });
    const templateRefs = templateRecordReferencesById(await listTemplateInstallations(workspaceId));
    res.status(200).json({ agent: await agentResponse(agent, templateRefs.get(agent.id) || null) });
  } catch (error) {
    if (error instanceof AgentNativeToolAssignmentError) {
      res.status(error.code.endsWith('NOT_FOUND') ? 404
        : error.code === 'NATIVE_TOOL_CONFIG_INVALID' ? 400
          : 409).json({
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
