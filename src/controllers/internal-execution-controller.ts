import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { incrementRunEventsIngested } from '../metrics.js';
import { publishRunEvents } from '../services/control-plane-coordination.js';
import { recordTargetChatActivityEvent } from '../services/target-chat-activity-events.js';
import { emitRunStatusTransition } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import {
  appendWorkflowRunEvents,
  getWorkflowRun,
  getWorkflowSession,
  listWorkflowMessages,
  updateWorkflowRun,
  upsertWorkflowAssistantFinalMessage,
} from '../store/repository-workflows.js';
import { runtime } from '../store/runtime.js';
import { RunEvent } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import {
  acceptsExecutionRunEvent,
  buildTerminalFailureMessage,
  isTerminalRunStatus,
  summarizeRunEventCounts
} from './internal-execution-events.js';

export { bootstrap } from './internal-execution-bootstrap.js';
export { summarizeRunEventCounts } from './internal-execution-events.js';

export async function getSessionContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const runId = String(req.query.run_id || '');
    const session = await repo.getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }

    if (runId) {
      const run = await repo.getRun(runId);
      if (!run || run.sessionId !== sessionId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found for session', retryable: false } });
        return;
      }
    }

    const messagesPage = await repo.listMessages(sessionId);
    const context = {
      messages: [
        {
          role: 'system',
          content: config.AGENT_SYSTEM_INSTRUCTION
        },
        ...messagesPage.items.map((message) => ({ role: message.role, content: message.content }))
      ],
      summaries: [],
      attachments: []
    };

    res.status(200).json(context);
  } catch (err) {
    next(err);
  }
}

export async function getWorkflowSessionContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const runId = String(req.query.run_id || '');
    const session = getWorkflowSession(sessionId);

    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow session not found', retryable: false } });
      return;
    }

    if (runId) {
      const run = getWorkflowRun(runId);
      if (!run || run.workflowSessionId !== sessionId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found for session', retryable: false } });
        return;
      }
    }

    const messages = listWorkflowMessages(sessionId);
    const context = {
      messages: [
        {
          role: 'system',
          content: [
            config.AGENT_SYSTEM_INSTRUCTION,
            'You are executing a workspace-scoped workflow. Use only the compiled workflow grants provided by control-plane.',
            `Workflow access scope: ${JSON.stringify({
              workflowId: session.compiledAccessScope.workflowId,
              mode: session.compiledAccessScope.mode,
              tools: session.compiledAccessScope.tools,
              contextGrants: session.compiledAccessScope.contextGrants,
              approvalGates: session.compiledAccessScope.approvalGates
            })}`
          ].join('\n\n')
        },
        ...messages.map((message) => ({ role: message.role, content: message.content }))
      ],
      summaries: [],
      attachments: []
    };

    res.status(200).json(context);
  } catch (err) {
    next(err);
  }
}

export async function ingestRunEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = getWorkflowRun(runId);
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
      const accepted = appendWorkflowRunEvents(currentRun.id, acceptedEvents);
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
          currentRun = updateWorkflowRun(currentRun.id, { status: 'running', startedAt: currentRun.startedAt || new Date().toISOString() }) || currentRun;
        } else if (event.type === 'tool_approval_requested') {
          currentRun = updateWorkflowRun(currentRun.id, { status: 'waiting_for_approval' }) || currentRun;
        } else if (event.type === 'run_failed') {
          currentRun = updateWorkflowRun(currentRun.id, {
            status: 'failed',
            errorCode: String((event.payload.code as string | undefined) || 'RUN_FAILED'),
            errorMessage: String((event.payload.message as string | undefined) || 'Run failed'),
            endedAt: new Date().toISOString()
          }) || currentRun;
        } else if (event.type === 'run_cancelled') {
          currentRun = updateWorkflowRun(currentRun.id, { status: 'cancelled', endedAt: new Date().toISOString() }) || currentRun;
        }
        runtime.runStreams.emit(`run:${currentRun.id}`, { event });
      }

      res.status(200).json({ status: 'ok', accepted: buffered.length });
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
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      const latestSeq = Math.max(0, ...(workflowRun.events || runtime.getRunEvents(workflowRun.id)).map((event) => event.seq));
      res.status(200).json({ latestSeq });
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
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      if (isTerminalRunStatus(workflowRun.status)) {
        res.status(200).json({ status: 'ok', terminal: true });
        return;
      }
      const assistantMessage = req.body.status === 'cancelled'
        ? { ...req.body.assistant_message, content: '' }
        : req.body.assistant_message;

      const updatedRun = updateWorkflowRun(workflowRun.id, {
        status: req.body.status,
        startedAt: req.body.timing.started_at,
        endedAt: req.body.timing.ended_at,
        usage: req.body.usage,
        assistantMessage
      }) || workflowRun;

      const committedContent = String(assistantMessage?.content || '').trim();
      if (committedContent) {
        upsertWorkflowAssistantFinalMessage({
          sessionId: workflowRun.workflowSessionId,
          runId: workflowRun.id,
          workspaceId: workflowRun.workspaceId,
          workflowId: workflowRun.workflowId,
          content: committedContent
        });
      } else if (req.body.status === 'failed' || req.body.status === 'cancelled') {
        upsertWorkflowAssistantFinalMessage({
          sessionId: workflowRun.workflowSessionId,
          runId: workflowRun.id,
          workspaceId: workflowRun.workspaceId,
          workflowId: workflowRun.workflowId,
          content: buildTerminalFailureMessage(req.body.status, updatedRun.errorMessage || workflowRun.errorMessage)
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
          status: req.body.status
        }
      });

      res.status(200).json({ status: 'ok' });
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (isTerminalRunStatus(run.status)) {
      res.status(200).json({ status: 'ok', terminal: true });
      return;
    }

    const assistantMessage = req.body.status === 'cancelled'
      ? { ...req.body.assistant_message, content: '' }
      : req.body.assistant_message;

    const updatedRun = await repo.updateRun(run.id, {
      status: req.body.status,
      startedAt: req.body.timing.started_at,
      endedAt: req.body.timing.ended_at,
      usage: req.body.usage,
      assistantMessage
    });
    emitRunStatusTransition(run, updatedRun);

    const commitAssistantFinalMessage = async (content: string) => {
      const message = await repo.upsertAssistantFinalMessage(run.sessionId, run.id, content);
      await recordTargetChatActivityEvent({
        workspaceId: run.workspaceId,
        targetId: run.targetId,
        targetType: run.targetType,
        sessionId: run.sessionId,
        runId: run.id,
        messageId: message.id,
        type: 'assistant_message.committed',
        payload: {
          status: req.body.status,
          contentLength: content.length,
          committedAt: new Date().toISOString()
        }
      });
    };

    const committedContent = String(assistantMessage?.content || '').trim();
    if (committedContent) {
      await commitAssistantFinalMessage(committedContent);
    } else if (req.body.status === 'failed' || req.body.status === 'cancelled') {
      const failureMessage = buildTerminalFailureMessage(req.body.status, updatedRun?.errorMessage || run.errorMessage);
      await commitAssistantFinalMessage(failureMessage);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
}

export async function getRunCommit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = getWorkflowRun(runId);
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
