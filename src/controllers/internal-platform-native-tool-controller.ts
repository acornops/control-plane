import type { NextFunction, Request, Response } from 'express';
import {
  executeWorkspaceNativeTool,
  WorkspaceNativeToolExecutionError
} from '../services/workspace-native-tool-executor.js';
import { getWorkspaceNativeTool } from '../services/workspace-native-tools.js';
import { repo } from '../store/repository.js';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';

const ACTIVE_TOOL_RUN_STATUSES = new Set(['dispatching', 'running', 'waiting_for_approval']);

export async function callPlatformNativeTool(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const toolId = toSingleParam(req.params.toolId);
    const tool = getWorkspaceNativeTool(toolId);
    if (!tool) {
      res.status(404).json({ error: { code: 'NATIVE_TOOL_NOT_FOUND', message: 'Native tool not found.', retryable: false } });
      return;
    }

    const workflowRun = await getWorkflowRun(runId);
    const targetRun = workflowRun ? null : await repo.getRun(runId);
    const agentRun = workflowRun || targetRun ? null : await getAgentActivityRecord(runId);
    const run = workflowRun || targetRun;
    if (!run && !agentRun) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (agentRun || !run) {
      res.status(403).json({ error: {
        code: 'WORKSPACE_NATIVE_TOOL_SCOPE_DENIED',
        message: 'This native tool is not available to direct Agent runs.',
        retryable: false
      } });
      return;
    }

    const invocationScope = workflowRun ? 'workflow' : 'target_chat';
    if (!tool.invocationScopes.includes(invocationScope)) {
      res.status(403).json({ error: {
        code: 'WORKSPACE_NATIVE_TOOL_SCOPE_DENIED',
        message: `Native tool is not available for ${invocationScope} runs.`,
        retryable: false
      } });
      return;
    }
    if (workflowRun && !workflowRun.compiledAccessScope.tools.includes(toolId)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this workflow run', retryable: false } });
      return;
    }
    if (!ACTIVE_TOOL_RUN_STATUSES.has(run.status)) {
      res.status(409).json({ error: { code: 'RUN_NOT_ACTIVE', message: 'Run is not active for tool execution', retryable: false } });
      return;
    }

    try {
      const result = await executeWorkspaceNativeTool({
        run,
        toolId,
        toolCallId: req.body.toolCallId,
        arguments: req.body.arguments || {}
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof WorkspaceNativeToolExecutionError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message, retryable: false } });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
}
