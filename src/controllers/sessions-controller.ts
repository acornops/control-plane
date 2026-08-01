import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import {
  requireClusterAccess,
  requireTargetAccess,
  requireWorkspaceCapability,
  requireWorkspaceDataRead
} from '../auth/workspace-authorization.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { recordTargetChatActivityEvent } from '../services/target-chat-activity-events.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { repo } from '../store/repository.js';
import {
  ChatSession,
  KUBERNETES_TARGET_TYPE,
  TargetType,
  VIRTUAL_MACHINE_TARGET_TYPE
} from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../utils/pagination.js';
import { mapGatewayError } from './workspaces/common.js';
import { runAuditActor, runRequestProvenance } from './run-actor.js';
import { acceptedMessageResponse, parseRequestedLlmSelection } from './session-llm-selection.js';
import { resolveReadySessionAssistantReferences } from './session-assistant-references.js';
import { resolveSessionMessageAccess } from './session-message-access.js';
import { enqueueInteractiveRunDispatch } from './run-controller-helpers.js';
import { rejectUnavailableInteractiveLlm } from './interactive-llm-validation.js';
async function requireSessionTargetAccess(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string
): Promise<{ targetId: string; targetType: TargetType; clusterId?: string } | null> {
  const clusterId = toSingleParam(req.params.clusterId);
  if (clusterId) {
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return null;
    }
    return { targetId: clusterId, targetType: KUBERNETES_TARGET_TYPE, clusterId };
  }

  const targetId = toSingleParam(req.params.targetId);
  const access = await requireTargetAccess(req, res, workspaceId, targetId);
  if (!access) {
    return null;
  }
  return {
    targetId: access.target.id,
    targetType: access.target.targetType,
    clusterId: access.target.targetType === KUBERNETES_TARGET_TYPE ? access.target.id : undefined
  };
}

async function requireRunnableSessionTarget(
  res: Response,
  session: ChatSession
): Promise<{ targetId: string; targetType: TargetType; clusterId?: string } | null> {
  if (session.conversationKind === 'agent_chat' || !session.targetId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target session not found', retryable: false } });
    return null;
  }
  const target = await repo.getTarget(session.workspaceId, session.targetId);
  if (!target) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found for session', retryable: false } });
    return null;
  }
  if (target.targetType !== KUBERNETES_TARGET_TYPE && target.targetType !== VIRTUAL_MACHINE_TARGET_TYPE) {
    res.status(400).json({
      error: {
        code: 'UNSUPPORTED_TARGET_TYPE',
        message: `Troubleshooting runs are not available for target_type=${target.targetType} yet`,
        retryable: false
      }
    });
    return null;
  }
  return {
    targetId: target.id,
    targetType: target.targetType,
    clusterId: target.targetType === KUBERNETES_TARGET_TYPE ? target.id : undefined
  };
}

export async function createSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetAccess = await requireSessionTargetAccess(req, res, workspaceId);
    if (!targetAccess) {
      return;
    }
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'create_sessions',
        'Only workspace roles with session creation capability can create troubleshooting sessions'
      ))
    ) {
      return;
    }

    const session = await repo.addSession(workspaceId, targetAccess.targetId, req.auth.userId, req.body.title);
    webhooks.emit({
      type: 'session.created.v1',
      workspaceId,
      clusterId: targetAccess.clusterId,
      targetId: targetAccess.targetId,
      targetType: targetAccess.targetType,
      subject: { type: 'session', id: session.id },
      data: {
        title: session.title,
        createdBy: session.createdBy,
        createdAt: session.createdAt
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'session',
      eventType: 'session.created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'session',
      objectId: session.id,
      objectName: session.title,
      summary: 'Troubleshooting session created',
      metadata: {
        targetId: targetAccess.targetId,
        targetType: targetAccess.targetType
      }
    });
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
}

export async function listSessions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetAccess = await requireSessionTargetAccess(req, res, workspaceId);
    if (!targetAccess) {
      return;
    }

    const q = normalizeSearchQuery(req.query.q);
    const status = toSingleParam(req.query.status as string | string[] | undefined);
    const filters: { q: string; status?: ChatSession['status'] } = {
      q,
      status: status === 'open' || status === 'archived' || status === 'deleted' ? status : undefined
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ lastMessageAt: string; sessionId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listSessionsByTarget(workspaceId, targetAccess.targetId, {
      limit: parseBoundedLimit(req.query.limit, 20, 100),
      cursor,
      q,
      status: filters.status,
      signature
    });
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await repo.getSession(toSingleParam(req.params.sessionId));
    if (!session || session.conversationKind === 'agent_chat') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }
    if (!(await requireWorkspaceDataRead(req, res, session.workspaceId, 'No access to session'))) return;
    res.status(200).json(session);
  } catch (err) {
    next(err);
  }
}

export async function listMessages(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const session = await repo.getSession(sessionId);
    if (!session || session.conversationKind === 'agent_chat') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }

    if (!(await requireWorkspaceDataRead(req, res, session.workspaceId, 'No access to session'))) {
      return;
    }

    const limit = parseBoundedLimit(req.query.limit, 100, 200);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const signature = makeQuerySignature({ before: before || '' });
    const cursor = decodeCursor<{ createdAt: string; messageId: string; signature: string }>(req.query.cursor, signature);
    const messages = await repo.listMessages(session.id, { before, limit, cursor, signature });
    res.status(200).json(messages);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function deleteSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const session = await repo.getSession(sessionId);
    if (!session || session.conversationKind === 'agent_chat') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }

    if (!(await requireWorkspaceDataRead(req, res, session.workspaceId, 'No access to session'))) {
      return;
    }
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        session.workspaceId,
        'delete_sessions',
        'Only workspace roles with session deletion capability can delete troubleshooting sessions'
      ))
    ) {
      return;
    }

    if (!session.targetId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target session not found', retryable: false } });
      return;
    }
    const target = await repo.getTarget(session.workspaceId, session.targetId);
    if (!target) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found for session', retryable: false } });
      return;
    }

    const deletion = await repo.deleteSession(session.id);
    if (deletion.status === 'active_runs') {
      res.status(409).json({ error: {
        code: 'SESSION_HAS_ACTIVE_RUNS',
        message: 'Wait for active runs to finish or cancel them before deleting this session.',
        retryable: false,
        details: { runIds: deletion.runIds }
      } });
      return;
    }
    if (deletion.status === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }
    await recordTargetChatActivityEvent({
      workspaceId: session.workspaceId,
      targetId: session.targetId,
      targetType: target.targetType,
      sessionId: session.id,
      type: 'session.deleted',
      payload: {
        deletedBy: req.auth.userId,
        deletedAt: new Date().toISOString()
      }
    });

    webhooks.emit({
      type: 'session.deleted.v1',
      workspaceId: session.workspaceId,
      targetId: session.targetId,
      targetType: target.targetType,
      clusterId: target.targetType === KUBERNETES_TARGET_TYPE ? session.targetId : undefined,
      subject: { type: 'session', id: session.id },
      data: {
        deletedBy: req.auth.userId
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'session',
      eventType: 'session.deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'session',
      objectId: session.id,
      objectName: session.title,
      summary: 'Troubleshooting session deleted',
      metadata: {
        targetId: session.targetId,
        targetType: target.targetType
      }
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function postMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const session = await repo.getSession(sessionId);
    if (!session || session.conversationKind === 'agent_chat') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }

    const authz = await requireWorkspaceDataRead(req, res, session.workspaceId, 'No access to session');
    if (!authz) {
      return;
    }

    const access = resolveSessionMessageAccess({
      authz,
      credentialType: req.auth.credential.type,
      requestedToolAccessMode: req.body.toolAccessMode,
      session,
      userId: req.auth.userId
    });
    if (!access.allowed) {
      res.status(403).json({ error: { code: access.code, message: access.message, retryable: false } });
      return;
    }
    const { sharedAutomaticSession, toolAccessMode } = access;
    // A retry for an already accepted client message must remain idempotent even
    // if provider or MCP credential connection state changed after dispatch.
    if (req.body.clientMessageId) {
      const existing = await repo.findRunByClientMessageId(session.id, req.body.clientMessageId);
      if (existing) {
        res.status(202).json(acceptedMessageResponse(existing.message.id, existing.run));
        return;
      }
    }
    const target = await requireRunnableSessionTarget(res, session);
    if (!target) {
      return;
    }
    const assistantReferences = await resolveReadySessionAssistantReferences(
      res, session.workspaceId, target, req.auth.userId, toolAccessMode, req.body.references || []
    );
    if (!assistantReferences) return;
    const requestedLlm = parseRequestedLlmSelection(req, res);
    if (requestedLlm === null) {
      return;
    }
    const llmSettings = await resolveWorkspaceLlmSettings(session.workspaceId, requestedLlm);
    if (rejectUnavailableInteractiveLlm(res, llmSettings, {
      credentialMessage: 'Configure an AI provider API key in AI Settings before starting an assistant run.'
    })) return;
    const created = await repo.createRunFromUserMessage({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      targetId: target.targetId,
      targetType: target.targetType,
      content: req.body.content,
      toolAccessMode,
      llmProvider: llmSettings.provider,
      llmModel: llmSettings.model,
      llmReasoningSummaryMode: llmSettings.reasoning.summary_mode,
      llmReasoningEffort: llmSettings.reasoning.effort,
      clientMessageId: req.body.clientMessageId,
      assistantReferences,
      principal: { type: 'user', id: req.auth.userId },
      requestProvenance: runRequestProvenance(req),
      messageCreatedBy: req.auth.userId,
      confirmationRequiredForWriteOverride: sharedAutomaticSession && toolAccessMode === 'read_write'
        ? session.automaticInvestigation?.confirmationRequiredForWrite
        : undefined
    });
    if (!created.idempotent) {
      webhooks.emit({
        type: 'message.received.v1',
        workspaceId: session.workspaceId,
        clusterId: target.clusterId,
        targetId: target.targetId,
        targetType: target.targetType,
        subject: { type: 'message', id: created.message.id },
        data: {
          sessionId: session.id,
          runId: created.run.id,
          role: created.message.role,
          kind: created.message.kind,
          clientMessageId: created.message.clientMessageId || null,
          contentLength: created.message.content.length
        }
      });
      webhooks.emit({
        type: 'run.created.v1',
        workspaceId: session.workspaceId,
        clusterId: target.clusterId,
        targetId: target.targetId,
        targetType: target.targetType,
        subject: { type: 'run', id: created.run.id },
        data: {
          sessionId: session.id,
          messageId: created.message.id,
          status: created.run.status,
          toolAccessMode: created.run.toolAccessMode,
          requestedAt: created.run.requestedAt
        }
      });
      await recordTargetChatActivityEvent({
        workspaceId: session.workspaceId,
        targetId: target.targetId,
        targetType: target.targetType,
        sessionId: session.id,
        runId: created.run.id,
        messageId: created.message.id,
        type: 'message.created',
        payload: {
          role: created.message.role,
          kind: created.message.kind,
          clientMessageId: created.message.clientMessageId || null,
          createdAt: created.message.createdAt
        }
      });
      await recordTargetChatActivityEvent({
        workspaceId: session.workspaceId,
        targetId: target.targetId,
        targetType: target.targetType,
        sessionId: session.id,
        runId: created.run.id,
        messageId: created.message.id,
        type: 'run.created',
        payload: {
          status: created.run.status,
          toolAccessMode: created.run.toolAccessMode,
          requestedAt: created.run.requestedAt
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId: session.workspaceId,
        category: 'run',
        eventType: 'run.created.v1',
        operation: 'write',
        ...runAuditActor(req),
        objectType: 'run',
        objectId: created.run.id,
        summary: 'Troubleshooting run created',
        metadata: {
          sessionId: session.id,
          targetId: target.targetId,
          targetType: target.targetType,
          toolAccessMode: created.run.toolAccessMode,
          assistantReferences: assistantReferences.map((reference) => ({ kind: reference.kind, id: reference.id }))
        }
      });
      enqueueInteractiveRunDispatch(created.run);
    }
    res.status(202).json(acceptedMessageResponse(created.message.id, created.run));
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: 'Failed to check workspace AI provider settings with llm-gateway' });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
