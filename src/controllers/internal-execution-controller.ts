import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { incrementAutomationTerminalOutcome } from '../metrics.js';
import { incrementTargetInsightsRetrieval, incrementRunEventsIngested } from '../metrics.js';
import { publishRunEvents } from '../services/control-plane-coordination.js';
import { TARGET_INSIGHTS_TOOL_ID, normalizeTargetInsightsConfig } from '../services/target-insights/config.js';
import { emitRunStatusTransition } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { advanceWorkflowExecution } from '../services/workflow-state-machine.js';
import { repo } from '../store/repository.js';
import {
  appendWorkflowRunEvents,
  getWorkflowRun,
  updateWorkflowRun,
  upsertWorkflowAssistantFinalMessage,
} from '../store/repository-workflows.js';
import { runtime } from '../store/runtime.js';
import { appendAgentRunEvents, getAgentActivityRecord, listAgentRunEvents, updateAgentActivityRecord } from '../store/repository-agents.js';
import { workflowDelegationCompletionGate } from '../store/repository-workflow-delegations.js';
import { RunEvent } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import {
  acceptsExecutionRunEvent,
  buildTerminalFailureMessage,
  isTerminalRunStatus,
  shouldReconcileFailedRunCommit,
  summarizeRunEventCounts
} from './internal-execution-events.js';
import { commitTargetAssistantFinalMessage } from './internal-target-run-commit.js';

export { bootstrap } from './internal-execution-bootstrap.js';
export { summarizeRunEventCounts } from './internal-execution-events.js';
export { getAgentRunContext, getWorkflowSessionContext } from './internal-automation-context-controller.js';
export { getAgentRunSkillSnapshot, getRunSkillSnapshot } from './internal-execution-skill-controller.js';

function buildTargetInsightsContextMessage(snippets: Awaited<ReturnType<typeof repo.searchTargetInsightsSnippets>>): string {
  return [
    'Target Insights context retrieved for this target. Use it as prior operational evidence, but verify against live tool output before making claims.',
    ...snippets.map((snippet, index) => [
      '',
      `${index + 1}. ${snippet.title}`,
      snippet.evidenceSummary ? `Evidence: ${snippet.evidenceSummary}` : undefined,
      `Confidence: ${snippet.confidence}; observations: ${snippet.observationCount}`,
      snippet.tags.length ? `Tags: ${snippet.tags.join(', ')}` : undefined,
      snippet.body
    ].filter(Boolean).join('\n'))
  ].join('\n');
}

type TargetInsightsRetrievalStatus = 'disabled' | 'skipped' | 'hit' | 'miss' | 'error';

export async function getSessionContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const runId = String(req.query.run_id || '');
    const session = await repo.getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }

    let run = null;
    if (runId) {
      run = await repo.getRun(runId);
      if (!run || run.sessionId !== sessionId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found for session', retryable: false } });
        return;
      }
    }

    const messagesPage = await repo.listMessages(sessionId);
    let insightSnippets: Awaited<ReturnType<typeof repo.searchTargetInsightsSnippets>> = [];
    let insightsRetrievalStatus: TargetInsightsRetrievalStatus = config.TARGET_INSIGHTS_ENABLED ? 'skipped' : 'disabled';
    if (config.TARGET_INSIGHTS_ENABLED && run) {
      try {
        const setting = await repo.getTargetToolSetting(session.targetId, TARGET_INSIGHTS_TOOL_ID);
        if (setting?.enabled ?? true) {
          const toolConfig = normalizeTargetInsightsConfig(setting?.config);
          const query = messagesPage.items
            .map((message) => message.content)
            .join('\n')
            .slice(-8000);
          insightSnippets = await repo.searchTargetInsightsSnippets(session.workspaceId, session.targetId, query, {
            limit: toolConfig.retrieval.maxSnippetsPerRetrieval,
            maxSnippetSizeBytes: toolConfig.retrieval.maxSnippetSizeBytes
          });
          insightsRetrievalStatus = insightSnippets.length > 0 ? 'hit' : 'miss';
          incrementTargetInsightsRetrieval(insightSnippets.length > 0 ? 'hit' : 'miss');
        } else {
          insightsRetrievalStatus = 'skipped';
          incrementTargetInsightsRetrieval('skipped');
        }
      } catch (err) {
        insightSnippets = [];
        insightsRetrievalStatus = 'error';
        incrementTargetInsightsRetrieval('error');
        logger.warn({
          err,
          workspaceId: session.workspaceId,
          targetId: session.targetId,
          sessionId,
          runId
        }, 'Target Insights retrieval failed; continuing without snippets');
      }
    }
    const context = {
      messages: [
        ...(insightSnippets.length > 0 ? [{
          role: 'system',
          content: buildTargetInsightsContextMessage(insightSnippets)
        }] : []),
        ...messagesPage.items.map((message) => ({ role: message.role, content: message.content }))
      ],
      summaries: [],
      attachments: [],
      target_insights: {
        retrieval_status: insightsRetrievalStatus,
        snippets: insightSnippets.map((snippet) => ({
          entry_id: snippet.entryId,
          title: snippet.title,
          evidence_summary: snippet.evidenceSummary,
          tags: snippet.tags,
          confidence: snippet.confidence,
          observation_count: snippet.observationCount,
          score: snippet.score,
          updated_at: snippet.updatedAt
        }))
      }
    };

    res.status(200).json(context);
  } catch (err) {
    next(err);
  }
}

export async function ingestRunEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      let currentRun = workflowRun;
      const incomingEvents = Array.isArray(req.body.events) ? req.body.events as RunEvent[] : [];
      const acceptedEvents: RunEvent[] = [];
      let filterStatus = currentRun.status;
      for (const event of incomingEvents) {
        if (!acceptsExecutionRunEvent(filterStatus, event)) {
          continue;
        }
        acceptedEvents.push(event);
        if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
          filterStatus = event.type === 'run_completed'
            ? 'completed'
            : event.type === 'run_failed'
              ? 'failed'
              : 'cancelled';
        }
      }
      if (acceptedEvents.length === 0) {
        res.status(200).json({ status: 'ok', accepted: 0 });
        return;
      }
      const accepted = await appendWorkflowRunEvents(currentRun.id, acceptedEvents);
      const buffered = runtime.appendRunEvents(currentRun.id, accepted);
      const bufferedEventCounts = summarizeRunEventCounts(buffered);
      for (const [eventType, count] of bufferedEventCounts.entries()) {
        incrementRunEventsIngested(eventType, count);
      }
      for (const event of buffered) {
        if (isTerminalRunStatus(currentRun.status)) {
          runtime.runStreams.emit(`run:${currentRun.id}`, { event });
          continue;
        }
        if (event.type === 'run_started') {
          currentRun = await updateWorkflowRun(currentRun.id, { status: 'running', startedAt: currentRun.startedAt || new Date().toISOString() }) || currentRun;
        } else if (event.type === 'tool_approval_requested') {
          currentRun = await updateWorkflowRun(currentRun.id, { status: 'waiting_for_approval' }) || currentRun;
        } else if (event.type === 'run_failed') {
          currentRun = await updateWorkflowRun(currentRun.id, {
            status: 'failed',
            errorCode: String((event.payload.code as string | undefined) || 'RUN_FAILED'),
            errorMessage: String((event.payload.message as string | undefined) || 'Run failed'),
            endedAt: new Date().toISOString()
          }) || currentRun;
        } else if (event.type === 'run_cancelled') {
          currentRun = await updateWorkflowRun(currentRun.id, { status: 'cancelled', endedAt: new Date().toISOString() }) || currentRun;
        }
        runtime.runStreams.emit(`run:${currentRun.id}`, { event });
      }

      res.status(200).json({ status: 'ok', accepted: buffered.length });
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      const incomingEvents = Array.isArray(req.body.events) ? req.body.events as RunEvent[] : [];
      const accepted = await appendAgentRunEvents(agentRun, incomingEvents);
      for (const event of accepted) {
        if (event.type === 'run_started') await updateAgentActivityRecord(runId, { status: 'running', startedAt: agentRun.startedAt || new Date().toISOString() });
        else if (event.type === 'tool_approval_requested') await updateAgentActivityRecord(runId, { status: 'waiting_for_approval' });
        else if (event.type === 'run_failed') await updateAgentActivityRecord(runId, { status: 'failed', endedAt: new Date().toISOString(),
          errorCode: String(event.payload.code || 'RUN_FAILED'), errorMessage: String(event.payload.message || 'Run failed') });
        else if (event.type === 'run_cancelled') await updateAgentActivityRecord(runId, { status: 'cancelled', endedAt: new Date().toISOString() });
        runtime.runStreams.emit(`run:${runId}`, { event });
      }
      res.status(200).json({ status: 'ok', accepted: accepted.length });
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    let currentRun = run;
    const incomingEvents = Array.isArray(req.body.events) ? req.body.events as RunEvent[] : [];
    const acceptedEvents: RunEvent[] = [];
    let filterStatus = currentRun.status;
    for (const event of incomingEvents) {
      if (!acceptsExecutionRunEvent(filterStatus, event)) {
        continue;
      }
      acceptedEvents.push(event);
      if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
        filterStatus = event.type === 'run_completed'
          ? 'completed'
          : event.type === 'run_failed'
            ? 'failed'
            : 'cancelled';
      }
    }
    if (acceptedEvents.length === 0) {
      res.status(200).json({ status: 'ok', accepted: 0 });
      return;
    }
    const accepted = await repo.appendRunEvents(run.id, acceptedEvents);
    const buffered = runtime.appendRunEvents(run.id, accepted);
    const bufferedEventCounts = summarizeRunEventCounts(buffered);
    for (const [eventType, count] of bufferedEventCounts.entries()) {
      incrementRunEventsIngested(eventType, count);
    }
    logger.info(
      {
        runId: run.id,
        workspaceId: run.workspaceId,
        accepted: buffered.length,
        eventTypes: Object.fromEntries(bufferedEventCounts)
      },
      'Accepted execution run events'
    );
    for (const event of buffered) {
      if (isTerminalRunStatus(currentRun.status)) {
        runtime.runStreams.emit(`run:${run.id}`, { event });
        continue;
      }
      if (event.type === 'run_started') {
        const updatedRun = await repo.updateRun(run.id, { status: 'running', startedAt: currentRun.startedAt || new Date().toISOString() });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      } else if (event.type === 'tool_approval_requested') {
        const updatedRun = await repo.updateRun(run.id, { status: 'waiting_for_approval' });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      } else if (event.type === 'run_failed') {
        const updatedRun = await repo.updateRun(run.id, {
          status: 'failed',
          errorCode: String((event.payload.code as string | undefined) || 'RUN_FAILED'),
          errorMessage: String((event.payload.message as string | undefined) || 'Run failed'),
          endedAt: new Date().toISOString()
        });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      } else if (event.type === 'run_cancelled') {
        const updatedRun = await repo.updateRun(run.id, { status: 'cancelled', endedAt: new Date().toISOString() });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      }
      runtime.runStreams.emit(`run:${run.id}`, { event });
    }
    publishRunEvents(run.id, buffered).catch((err) => {
      logger.warn({ err, runId: run.id }, 'Failed publishing distributed run events');
    });

    res.status(200).json({ status: 'ok', accepted: buffered.length });
  } catch (err) {
    next(err);
  }
}

export async function getRunEventCursor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      const latestSeq = Math.max(0, ...(workflowRun.events || runtime.getRunEvents(workflowRun.id)).map((event) => event.seq));
      res.status(200).json({ latestSeq });
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      const events = await listAgentRunEvents(runId);
      res.status(200).json({ latestSeq: Math.max(0, ...events.map((event) => event.seq)) });
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    const latestSeq = config.PERSIST_RUN_EVENTS
      ? await repo.getLatestRunEventSeq(run.id)
      : Math.max(0, ...runtime.getRunEvents(run.id).map((event) => event.seq));
    res.status(200).json({ latestSeq });
  } catch (err) {
    next(err);
  }
}

export async function commitRun(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      if (isTerminalRunStatus(workflowRun.status)) {
        res.status(200).json({ status: 'ok', terminal: true });
        return;
      }
      let terminalStatus = req.body.status as 'completed' | 'failed' | 'cancelled';
      let delegationFailure: string | undefined;
      if (terminalStatus === 'completed' && workflowRun.compiledAccessScope.entryAgent.kind === 'manager') {
        const gate = await workflowDelegationCompletionGate(workflowRun.executionId);
        if (!gate.allowed) {
          terminalStatus = 'failed';
          delegationFailure = gate.reason || 'Required specialist delegation did not complete.';
        }
      }
      const assistantMessage = terminalStatus === 'cancelled'
        ? { ...req.body.assistant_message, content: '' }
        : delegationFailure
          ? { ...req.body.assistant_message, content: `${String(req.body.assistant_message?.content || '').trim()}\n\nDelegation failure: ${delegationFailure}`.trim() }
          : req.body.assistant_message;

      const updatedRun = await updateWorkflowRun(workflowRun.id, {
        status: terminalStatus,
        startedAt: req.body.timing.started_at,
        endedAt: req.body.timing.ended_at,
        usage: req.body.usage,
        assistantMessage,
        ...(delegationFailure ? { errorCode: 'REQUIRED_DELEGATION_FAILED', errorMessage: delegationFailure } : {})
      }) || workflowRun;

      const committedContent = String(assistantMessage?.content || '').trim();
      if (committedContent) {
        await upsertWorkflowAssistantFinalMessage({
          sessionId: workflowRun.workflowSessionId,
          runId: workflowRun.id,
          workspaceId: workflowRun.workspaceId,
          workflowId: workflowRun.workflowId,
          content: committedContent
        });
      } else if (terminalStatus === 'failed' || terminalStatus === 'cancelled') {
        await upsertWorkflowAssistantFinalMessage({
          sessionId: workflowRun.workflowSessionId,
          runId: workflowRun.id,
          workspaceId: workflowRun.workspaceId,
          workflowId: workflowRun.workflowId,
          content: buildTerminalFailureMessage(terminalStatus, updatedRun.errorMessage || workflowRun.errorMessage)
        });
      }

      await recordWorkspaceAuditEvent({
        workspaceId: workflowRun.workspaceId,
        category: 'run',
        eventType: 'workflow.run_committed.v1',
        operation: 'write',
        actorType: 'system',
        objectType: 'workflow_run',
        objectId: workflowRun.id,
        objectName: workflowRun.workflowId,
        summary: 'Workflow run output committed',
        metadata: {
          workflowId: workflowRun.workflowId,
          workflowRunId: workflowRun.workflowRunId,
          workflowSessionId: workflowRun.workflowSessionId,
          status: terminalStatus
        }
      });
      const transition = await advanceWorkflowExecution(
        updatedRun,
        terminalStatus,
        Array.isArray(req.body.output_artifacts) ? req.body.output_artifacts : []
      );
      incrementAutomationTerminalOutcome('workflow', terminalStatus);
      res.status(200).json({ status: 'ok', executionStatus: transition.executionStatus });
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      if (agentRun.endedAt) {
        res.status(200).json({ status: 'ok', terminal: true });
        return;
      }
      await updateAgentActivityRecord(runId, {
        status: req.body.status,
        startedAt: req.body.timing.started_at,
        endedAt: req.body.timing.ended_at,
        usage: req.body.usage,
        assistantMessage: req.body.status === 'cancelled' ? { ...req.body.assistant_message, content: '' } : req.body.assistant_message
      });
      await recordWorkspaceAuditEvent({
        workspaceId: agentRun.workspaceId, category: 'run', eventType: 'agent.run_committed.v1', operation: 'write',
        actorType: 'system', objectType: 'agent_run', objectId: agentRun.id, objectName: agentRun.agentId,
        summary: 'Agent run output committed', metadata: { agentId: agentRun.agentId, agentVersion: agentRun.agentVersion, status: req.body.status }
      });
      incrementAutomationTerminalOutcome('agent', req.body.status);
      res.status(200).json({ status: 'ok' });
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    const assistantMessage = req.body.status === 'cancelled'
      ? { ...req.body.assistant_message, content: '' }
      : req.body.assistant_message;
    if (isTerminalRunStatus(run.status)) {
      if (shouldReconcileFailedRunCommit(run.status, req.body.status, Boolean(run.assistantMessage))) {
        const committedContent = String(assistantMessage?.content || '').trim();
        await commitTargetAssistantFinalMessage(
          run,
          req.body.status,
          committedContent || buildTerminalFailureMessage('failed', run.errorMessage)
        );
        await repo.updateRun(run.id, {
          startedAt: run.startedAt || req.body.timing.started_at,
          endedAt: run.endedAt || req.body.timing.ended_at,
          usage: req.body.usage,
          assistantMessage
        });
        logger.info(
          { runId: run.id, workspaceId: run.workspaceId, status: run.status },
          'Reconciled terminal details for failed target run'
        );
        res.status(200).json({ status: 'ok', terminal: true });
        return;
      }
      res.status(200).json({ status: 'ok', terminal: true });
      return;
    }

    const updatedRun = await repo.updateRun(run.id, {
      status: req.body.status,
      startedAt: req.body.timing.started_at,
      endedAt: req.body.timing.ended_at,
      usage: req.body.usage,
      assistantMessage
    });
    emitRunStatusTransition(run, updatedRun);

    const committedContent = String(assistantMessage?.content || '').trim();
    if (committedContent) {
      await commitTargetAssistantFinalMessage(run, req.body.status, committedContent);
    } else if (req.body.status === 'failed' || req.body.status === 'cancelled') {
      const failureMessage = buildTerminalFailureMessage(req.body.status, updatedRun?.errorMessage || run.errorMessage);
      await commitTargetAssistantFinalMessage(run, req.body.status, failureMessage);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
}

export async function getRunCommit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      if (!workflowRun.endedAt) {
        res.status(200).json({});
        return;
      }
      res.status(200).json({
        status: workflowRun.status,
        assistant_message: workflowRun.assistantMessage,
        usage: workflowRun.usage,
        timing: {
          started_at: workflowRun.startedAt,
          ended_at: workflowRun.endedAt
        }
      });
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      if (!agentRun.endedAt) { res.status(200).json({}); return; }
      res.status(200).json({ status: agentRun.status, assistant_message: agentRun.assistantMessage,
        usage: agentRun.usage, timing: { started_at: agentRun.startedAt, ended_at: agentRun.endedAt } });
      return;
    }
    const run = await repo.getRun(runId);
    if (!run || !run.endedAt) {
      res.status(200).json({});
      return;
    }

    res.status(200).json({
      status: run.status,
      assistant_message: run.assistantMessage,
      usage: run.usage,
      timing: {
        started_at: run.startedAt,
        ended_at: run.endedAt
      }
    });
  } catch (err) {
    next(err);
  }
}
