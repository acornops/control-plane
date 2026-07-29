import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import {
  getWorkflowDefinition,
  isAgentChatCarrier,
  listWorkflowRunsForSession,
  listWorkflowSessions
} from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';
import { publicWorkflowRun } from './external-run-public.js';
import { publicWorkflowDefinition } from './workflow-public.js';

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export async function listSessions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = requestWorkspaceId(req);
    if (!workspaceId) {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_WORKSPACE_REQUIRED',
        message: 'workspaceId is required.',
        retryable: false
      } });
    }
    const workflowId = toSingleParam(req.params.workflowId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const workflow = await getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow || isAgentChatCarrier(workflow)) {
      return void res.status(404).json({ error: {
        code: 'NOT_FOUND',
        message: 'Workflow not found',
        retryable: false
      } });
    }
    res.status(200).json({
      items: await Promise.all((await listWorkflowSessions(workspaceId, workflowId)).map(async (session) => ({
        id: session.id,
        workspaceId: session.workspaceId,
        workflowId: session.workflowId,
        workflowVersion: session.workflowVersion,
        createdBy: session.createdBy,
        launchedAt: session.launchedAt,
        createdAt: session.createdAt,
        workflowSnapshot: session.workflowSnapshot
          ? publicWorkflowDefinition(session.workflowSnapshot)
          : undefined,
        runs: (await listWorkflowRunsForSession(session.id)).map((run) => publicWorkflowRun(run, true))
      })))
    });
  } catch (error) {
    next(error);
  }
}
