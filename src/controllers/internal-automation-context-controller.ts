import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import { getWorkflowRun, getWorkflowSession, listWorkflowMessages } from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';

export async function getWorkflowSessionContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const runId = String(req.query.run_id || '');
    const session = await getWorkflowSession(sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow session not found', retryable: false } });
      return;
    }
    const workflowRun = runId ? await getWorkflowRun(runId) : null;
    if (runId && (!workflowRun || workflowRun.workflowSessionId !== sessionId)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found for session', retryable: false } });
      return;
    }
    const messages = await listWorkflowMessages(sessionId);
    res.status(200).json({
      messages: [{
        role: 'system',
        content: [
          config.AGENT_SYSTEM_INSTRUCTION,
          'You are executing a workspace-scoped workflow. Use only the compiled workflow grants provided by control-plane.',
          workflowRun?.agentSnapshot?.instructions,
          workflowRun?.stepSnapshot?.instructions,
          `Workflow access scope: ${JSON.stringify({
            workflowId: session.compiledAccessScope.workflowId, executionId: workflowRun?.executionId,
            stepId: workflowRun?.workflowStepId, attempt: workflowRun?.attemptNumber,
            targetId: workflowRun?.targetId || null, targetType: workflowRun?.targetType || null,
            mode: session.compiledAccessScope.mode,
            tools: workflowRun?.compiledAccessScope.tools || session.compiledAccessScope.tools,
            contextGrants: workflowRun?.compiledAccessScope.contextGrants || session.compiledAccessScope.contextGrants,
            approvalGates: workflowRun?.compiledAccessScope.approvalGates || session.compiledAccessScope.approvalGates
          })}`
        ].filter(Boolean).join('\n\n')
      }, ...messages.map((message) => ({ role: message.role, content: message.content }))],
      summaries: [], attachments: []
    });
  } catch (err) { next(err); }
}

export async function getAgentRunContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const run = await getAgentActivityRecord(toSingleParam(req.params.runId));
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent run not found', retryable: false } });
      return;
    }
    const prompt = typeof run.inputContext.prompt === 'string' ? run.inputContext.prompt : '';
    res.status(200).json({
      messages: [
        { role: 'system', content: [config.AGENT_SYSTEM_INSTRUCTION, run.agentSnapshot?.instructions || '',
          `Agent scope: ${JSON.stringify({ agentId: run.agentId, agentVersion: run.agentVersion,
            tools: run.compiledScope.tools, contextGrants: run.compiledScope.contextGrants,
            targetId: run.targetId || null, targetType: run.targetType || null })}`].filter(Boolean).join('\n\n') },
        { role: 'user', content: prompt }
      ],
      summaries: [], attachments: []
    });
  } catch (err) { next(err); }
}
