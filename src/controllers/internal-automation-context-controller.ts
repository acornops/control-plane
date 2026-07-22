import type { NextFunction, Request, Response } from 'express';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import { getWorkflowRun, getWorkflowSession } from '../store/repository-workflows.js';
import { promptResourceRegistry } from '../services/prompt-resources/index.js';
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
    if (!runId || !workflowRun || workflowRun.workflowSessionId !== sessionId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found for session', retryable: false } });
      return;
    }
    const inlineBindings = workflowRun.compiledAccessScope.resourceBindings.filter((binding) => binding.contextMode === 'inline');
    const maximumBytes = 256 * 1024;
    const perResourceBytes = Math.max(4_096, Math.floor(maximumBytes / Math.max(1, inlineBindings.length)));
    const resources = await Promise.all(inlineBindings.map(async (binding) => {
      const provider = promptResourceRegistry.provider(binding.type);
      if (!provider || provider.descriptor().provider !== binding.provider || !provider.loadContext) {
        throw new Error(`Prompt resource provider ${binding.provider} cannot load inline context`);
      }
      const context = await provider.loadContext(binding, { runId, maximumBytes: perResourceBytes });
      if (Buffer.byteLength(JSON.stringify(context), 'utf8') > perResourceBytes) {
        throw new Error(`Prompt resource provider ${binding.provider} exceeded its inline context limit`);
      }
      return {
        bindingId: binding.bindingId,
        provider: binding.provider,
        resourceId: binding.resourceId,
        labelSnapshot: binding.labelSnapshot,
        retrievedAt: new Date().toISOString(),
        context
      };
    }));
    if (Buffer.byteLength(JSON.stringify(resources), 'utf8') > maximumBytes) {
      throw new Error('Inline prompt resource context exceeded the aggregate limit');
    }
    const messages = resources.flatMap((resource) => {
      const values = resource.context.messages;
      return Array.isArray(values) ? values : [];
    }).filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === 'object' && !Array.isArray(message));
    res.status(200).json({
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      resources,
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
        { role: 'user', content: prompt }
      ],
      summaries: [], attachments: []
    });
  } catch (err) { next(err); }
}
