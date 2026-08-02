import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import {
  requireWorkspaceCapability,
  requireWorkspaceDataRead
} from '../auth/workspace-authorization.js';
import {
  agentConversationPolicyAllowsAccess,
  compileAgentConversationRunScope,
  compileAgentConversationMessage,
  defaultAgentConversationAccessMode,
  MAX_AGENT_CONVERSATION_MESSAGE_LENGTH
} from '../services/agent-chat.js';
import { CapabilityAccessDeniedError } from '../services/capability-access-errors.js';
import { getExactMcpReadinessReport, publicMcpReadinessError } from '../services/mcp-readiness.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import {
  addAgentConversationSession,
  AgentConversationStateConflictError,
  createAgentConversationRunFromUserMessage,
  deleteAgentConversationSession,
  listAgentConversationMessages,
  listAgentConversationRuns,
  listAgentConversationSessions,
  setAgentConversationAccessMode
} from '../store/repository-agent-conversations.js';
import { repo } from '../store/repository.js';
import type { ChatSession } from '../types/domain.js';
import type { AgentDefinition } from '../types/agents.js';
import { toSingleParam } from '../utils/params.js';
import { publicConversationRun } from './external-run-public.js';
import { enqueueInteractiveRunDispatch } from './run-controller-helpers.js';
import { runRequestProvenance } from './run-actor.js';
import { rejectUnavailableInteractiveLlm } from './interactive-llm-validation.js';

function agentConversationAccessMode(session: ChatSession): 'read_only' | 'read_write' {
  if (session.conversationKind !== 'agent_chat'
    || (session.preferredAccessMode !== 'read_only' && session.preferredAccessMode !== 'read_write')) {
    throw new Error('Agent conversation is missing its access mode');
  }
  return session.preferredAccessMode;
}

function publicConversation(session: ChatSession, agent: AgentDefinition) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    permissionMode: agent.permissionMode,
    title: session.title,
    createdBy: session.createdBy,
    accessMode: agentConversationAccessMode(session),
    launchedAt: session.launchedAt,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status
  };
}

async function loadConversationResponse(session: ChatSession, agent: AgentDefinition) {
  const [messages, runs] = await Promise.all([
    listAgentConversationMessages(session.id),
    listAgentConversationRuns(session.id)
  ]);
  return {
    conversation: publicConversation(session, agent),
    messages,
    runs: runs.map((run) => ({
      ...publicConversationRun(run, true),
      events: run.events
    }))
  };
}

async function requireAgentConversation(req: AuthenticatedRequest, res: Response): Promise<ChatSession | null> {
  const session = await repo.getSession(toSingleParam(req.params.conversationId));
  if (!session || session.conversationKind !== 'agent_chat') {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent conversation not found', retryable: false } });
    return null;
  }
  if (!(await requireWorkspaceDataRead(req, res, session.workspaceId, 'No access to Agent conversation'))) return null;
  return session;
}

export async function listAgentConversations(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const agentId = toSingleParam(req.params.agentId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const agent = await getAgentDefinition(workspaceId, agentId);
    if (!agent) {
      return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
    }
    const sessions = await listAgentConversationSessions(workspaceId, agentId);
    res.status(200).json({ items: sessions.map((session) => publicConversation(session, agent)) });
  } catch (error) {
    next(error);
  }
}

export async function createAgentConversation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const agentId = toSingleParam(req.params.agentId);
    const authz = await requireWorkspaceCapability(
      req, res, workspaceId, 'create_sessions', 'No permission to create Agent conversations'
    );
    if (!authz) return;
    const agent = await getAgentDefinition(workspaceId, agentId);
    if (!agent) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
    if (agent.status !== 'active' || agent.readiness.status !== 'ready') {
      return void res.status(409).json({ error: {
        code: 'AGENT_CHAT_NOT_READY',
        message: agent.readiness.reasons[0] || 'Agent configuration is not ready for chat.',
        retryable: false
      } });
    }
    const accessMode = defaultAgentConversationAccessMode(
      agent.permissionMode,
      authz.can('create_read_only_runs'),
      authz.can('create_read_write_runs')
    );
    if (!accessMode) {
      return void res.status(403).json({ error: {
        code: 'FORBIDDEN',
        message: 'No permission to create Agent runs under this Agent policy.',
        retryable: false
      } });
    }
    const session = await addAgentConversationSession({
      workspaceId,
      agentId,
      createdBy: req.auth.userId,
      title: agent.name,
      preferredAccessMode: accessMode
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'agent.conversation_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'agent_conversation',
      objectId: session.id,
      objectName: agent.name,
      summary: `Agent conversation created with ${accessMode} access`,
      metadata: { agentId, accessMode, permissionMode: agent.permissionMode }
    });
    res.status(201).json(await loadConversationResponse(session, agent));
  } catch (error) {
    next(error);
  }
}

export async function getAgentConversation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await requireAgentConversation(req, res);
    if (!session) return;
    const agent = session.agentId ? await getAgentDefinition(session.workspaceId, session.agentId) : null;
    if (!agent) {
      return void res.status(404).json({ error: {
        code: 'NOT_FOUND', message: 'Agent conversation not found', retryable: false
      } });
    }
    res.status(200).json(await loadConversationResponse(session, agent));
  } catch (error) {
    next(error);
  }
}

export async function deleteAgentConversation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await requireAgentConversation(req, res);
    if (!session) return;
    if (session.createdBy !== req.auth.userId) {
      return void res.status(403).json({ error: {
        code: 'AGENT_CONVERSATION_NOT_OWNED',
        message: 'Only the conversation creator may delete it.',
        retryable: false
      } });
    }
    if (!(await requireWorkspaceCapability(
      req, res, session.workspaceId, 'delete_sessions', 'No permission to delete Agent conversations'
    ))) return;
    const deletion = await deleteAgentConversationSession(session.id);
    if (deletion.status === 'active_runs') {
      return void res.status(409).json({ error: {
        code: 'AGENT_CONVERSATION_RUN_ACTIVE',
        message: 'Wait for active runs to finish or cancel them before deleting this conversation.',
        retryable: false,
        details: { runIds: deletion.runIds }
      } });
    }
    if (deletion.status === 'not_found') {
      return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent conversation not found', retryable: false } });
    }
    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'session',
      eventType: 'agent.conversation_deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'agent_conversation',
      objectId: session.id,
      objectName: session.title,
      summary: 'Agent conversation deleted',
      metadata: { agentId: session.agentId }
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function changeAgentConversationAccess(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await requireAgentConversation(req, res);
    if (!session) return;
    if (session.createdBy !== req.auth.userId) {
      return void res.status(403).json({ error: {
        code: 'AGENT_CONVERSATION_NOT_OWNED',
        message: 'Only the conversation creator may change access.',
        retryable: false
      } });
    }
    const accessMode = req.body?.accessMode;
    if (accessMode !== 'read_only' && accessMode !== 'read_write') {
      return void res.status(400).json({ error: {
        code: 'AGENT_CONVERSATION_ACCESS_MODE_INVALID',
        message: 'accessMode must be read_only or read_write.',
        retryable: false
      } });
    }
    const agent = session.agentId ? await getAgentDefinition(session.workspaceId, session.agentId) : null;
    if (!agent) {
      return void res.status(409).json({ error: {
        code: 'AGENT_CHAT_NOT_READY', message: 'Agent is no longer available.', retryable: false
      } });
    }
    if (!agentConversationPolicyAllowsAccess(agent.permissionMode, accessMode)) {
      return void res.status(409).json({ error: {
        code: 'AGENT_CONVERSATION_POLICY_READ_ONLY',
        message: 'This Agent currently permits read-only conversations.',
        retryable: false
      } });
    }
    const requiredCapability = accessMode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
    if (!(await requireWorkspaceCapability(
      req, res, session.workspaceId, requiredCapability, 'No permission to change Agent conversation access'
    ))) return;
    const previousAccessMode = agentConversationAccessMode(session);
    const updated = await setAgentConversationAccessMode(session.id, accessMode);
    if (!updated) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent conversation not found', retryable: false } });
    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'run',
      eventType: 'agent.conversation_access_changed.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'agent_conversation',
      objectId: session.id,
      objectName: session.title,
      summary: `Agent conversation access changed to ${accessMode}`,
      metadata: { agentId: session.agentId, previousAccessMode, accessMode }
    });
    res.status(200).json({ conversation: publicConversation(updated, agent) });
  } catch (error) {
    next(error);
  }
}

export async function postAgentConversationMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await requireAgentConversation(req, res);
    if (!session) return;
    if (session.createdBy !== req.auth.userId) {
      return void res.status(403).json({ error: {
        code: 'AGENT_CONVERSATION_NOT_OWNED',
        message: 'Only the conversation creator may continue it.',
        retryable: false
      } });
    }
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      return void res.status(400).json({ error: {
        code: 'AGENT_CONVERSATION_MESSAGE_REQUIRED', message: 'content is required.', retryable: false
      } });
    }
    if (content.length > MAX_AGENT_CONVERSATION_MESSAGE_LENGTH) {
      return void res.status(400).json({ error: {
        code: 'AGENT_CONVERSATION_MESSAGE_TOO_LONG',
        message: `content must not exceed ${MAX_AGENT_CONVERSATION_MESSAGE_LENGTH} characters.`,
        retryable: false
      } });
    }
    const suppliedClientRequestId = Object.prototype.hasOwnProperty.call(req.body || {}, 'clientRequestId');
    const clientRequestId = typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId.trim() : '';
    if (suppliedClientRequestId && (!clientRequestId || clientRequestId.length > 128)) {
      return void res.status(400).json({ error: {
        code: 'AGENT_CONVERSATION_CLIENT_REQUEST_ID_INVALID',
        message: 'clientRequestId must be a non-empty string of at most 128 characters.',
        retryable: false
      } });
    }
    if (clientRequestId) {
      const existing = await repo.findRunByClientMessageId(session.id, clientRequestId);
      if (existing) {
        return void res.status(202).json({
          message_id: existing.message.id,
          run_id: existing.run.id,
          status: existing.run.status
        });
      }
    }
    const authz = await requireWorkspaceDataRead(req, res, session.workspaceId, 'No access to Agent conversation');
    if (!authz) return;
    const accessMode = agentConversationAccessMode(session);
    const requiredCapability = accessMode === 'read_write'
      ? 'create_read_write_runs'
      : 'create_read_only_runs';
    if (!authz.can(requiredCapability)) {
      return void res.status(403).json({ error: {
        code: 'FORBIDDEN', message: 'No permission to create a run with this conversation access mode.', retryable: false
      } });
    }
    const agent = session.agentId ? await getAgentDefinition(session.workspaceId, session.agentId) : null;
    if (!agent || agent.status !== 'active' || agent.readiness.status !== 'ready') {
      return void res.status(409).json({ error: {
        code: 'AGENT_CHAT_NOT_READY',
        message: agent?.readiness.reasons[0] || 'Agent is no longer ready for chat.',
        retryable: false
      } });
    }
    if (!agentConversationPolicyAllowsAccess(agent.permissionMode, accessMode)) {
      return void res.status(409).json({ error: {
        code: 'AGENT_CONVERSATION_POLICY_READ_ONLY',
        message: 'The Agent policy now permits read-only runs. Change this conversation to read-only to continue.',
        retryable: false
      } });
    }
    const compiledMessage = compileAgentConversationMessage(content);
    const compiledScope = await compileAgentConversationRunScope({
      agent,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      accessMode
    });
    const readiness = await getExactMcpReadinessReport(
      session.workspaceId,
      compiledScope.principal,
      compiledScope.mcpTools
    );
    if (readiness.errors.length > 0) {
      return void res.status(409).json({ error: publicMcpReadinessError(readiness) });
    }
    const llm = await resolveWorkspaceLlmSettings(session.workspaceId);
    if (rejectUnavailableInteractiveLlm(res, llm, {
      credentialMessage: 'Configure an AI provider credential before starting an Agent run.'
    })) return;
    const created = await createAgentConversationRunFromUserMessage({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      agent,
      content: compiledMessage.content,
      toolAccessMode: accessMode,
      compiledAccessScope: compiledScope,
      llmProvider: llm.provider,
      llmModel: llm.model,
      llmReasoningSummaryMode: llm.reasoning.summary_mode,
      llmReasoningEffort: llm.reasoning.effort,
      clientMessageId: clientRequestId || undefined,
      principal: { type: 'user', id: req.auth.userId },
      requestProvenance: runRequestProvenance(req),
      createdBy: req.auth.userId
    });
    if (!created.idempotent) {
      enqueueInteractiveRunDispatch(created.run);
      await recordWorkspaceAuditEvent({
        workspaceId: session.workspaceId,
        category: 'run',
        eventType: 'agent.conversation_run_created.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        objectType: 'run',
        objectId: created.run.id,
        objectName: agent.name,
        summary: 'Agent conversation run created',
        metadata: {
          conversationId: session.id,
          agentId: agent.id,
          accessMode
        }
      });
    }
    res.status(202).json({
      message_id: created.message.id,
      run_id: created.run.id,
      status: created.run.status
    });
  } catch (error) {
    if (error instanceof AgentConversationStateConflictError) {
      return void res.status(409).json({ error: {
        code: 'AGENT_CONVERSATION_CHANGED', message: error.message, retryable: true
      } });
    }
    if (error instanceof CapabilityAccessDeniedError) {
      const permissionDenied = error.code === 'CAPABILITY_PERMISSION_DENIED';
      return void res.status(permissionDenied ? 403 : 409).json({ error: {
        code: permissionDenied ? 'FORBIDDEN' : 'AGENT_CHAT_NOT_READY',
        message: error.message,
        retryable: !permissionDenied
      } });
    }
    next(error);
  }
}
