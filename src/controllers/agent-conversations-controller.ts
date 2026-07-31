import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import {
  requireWorkspaceCapability,
  requireWorkspaceDataRead
} from '../auth/workspace-authorization.js';
import {
  agentConversationPolicyAllowsAccess,
  defaultAgentConversationAccessMode,
  pinnedAgentCapabilityRevocation,
  prepareAgentConversation
} from '../services/agent-chat.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import {
  createWorkflowSession,
  deleteAgentConversationSession,
  getWorkflowSession,
  listAgentConversationSessions,
  listWorkflowMessages,
  listWorkflowRunsForSession,
  setAgentConversationAccessMode
} from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';
import { publicWorkflowRun } from './external-run-public.js';
import { postMessage as postWorkflowMessage } from './workflows-controller.js';

function publicConversation(session: Awaited<ReturnType<typeof getWorkflowSession>>) {
  if (!session) return null;
  const pinnedAgent = session.compiledAccessScope.selectedAgentSnapshots[0];
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    agentVersion: pinnedAgent?.version,
    permissionMode: pinnedAgent?.permissionMode,
    title: pinnedAgent?.name || 'Agent conversation',
    createdBy: session.createdBy,
    accessMode: session.accessMode,
    launchedAt: session.launchedAt,
    createdAt: session.createdAt
  };
}

async function loadConversationResponse(session: NonNullable<Awaited<ReturnType<typeof getWorkflowSession>>>) {
  const [messages, runs] = await Promise.all([
    listWorkflowMessages(session.id),
    listWorkflowRunsForSession(session.id)
  ]);
  return {
    conversation: publicConversation(session),
    messages,
    runs: runs.map((run) => publicWorkflowRun(run, true))
  };
}

async function requireAgentConversation(
  req: AuthenticatedRequest,
  res: Response
) {
  const session = await getWorkflowSession(toSingleParam(req.params.conversationId));
  if (!session || session.conversationOrigin !== 'agent_chat') {
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
    if (!(await getAgentDefinition(workspaceId, agentId))) {
      return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
    }
    const sessions = await listAgentConversationSessions(workspaceId, agentId);
    res.status(200).json({ items: sessions.map(publicConversation) });
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
    const prepared = await prepareAgentConversation({
      agent,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions }
    });
    const compiledAccessScope = accessMode === 'read_write'
      ? prepared.capabilityCeiling
      : prepared.readScope;
    const session = await createWorkflowSession({
      workflow: prepared.workflow,
      createdBy: req.auth.userId,
      compiledAccessScope,
      conversationOrigin: 'agent_chat',
      agentId,
      accessMode,
      agentChatReadScope: prepared.readScope,
      agentChatCapabilityCeiling: prepared.capabilityCeiling
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
      metadata: { agentId, agentVersion: agent.version, accessMode, permissionMode: agent.permissionMode }
    });
    res.status(201).json(await loadConversationResponse(session));
  } catch (error) {
    next(error);
  }
}

export async function getAgentConversation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await requireAgentConversation(req, res);
    if (!session) return;
    res.status(200).json(await loadConversationResponse(session));
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
    await deleteAgentConversationSession(session.id);
    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'session',
      eventType: 'agent.conversation_deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'agent_conversation',
      objectId: session.id,
      objectName: session.compiledAccessScope.selectedAgentSnapshots[0]?.name || 'Agent conversation',
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
    const pinnedAgent = session.agentChatCapabilityCeiling?.selectedAgentSnapshots[0]
      || session.compiledAccessScope.selectedAgentSnapshots[0];
    if (
      pinnedAgent
      && !agentConversationPolicyAllowsAccess(pinnedAgent.permissionMode, accessMode)
    ) {
      return void res.status(409).json({ error: {
        code: 'AGENT_CONVERSATION_POLICY_READ_ONLY',
        message: 'This Agent conversation is read-only by its pinned Agent policy.',
        retryable: false
      } });
    }
    const requiredCapability = accessMode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
    if (!(await requireWorkspaceCapability(
      req, res, session.workspaceId, requiredCapability, 'No permission to change Agent conversation access'
    ))) return;
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
      objectName: session.compiledAccessScope.selectedAgentSnapshots[0]?.name || 'Agent conversation',
      summary: `Agent conversation access changed to ${accessMode}`,
      metadata: { agentId: session.agentId, previousAccessMode: session.accessMode, accessMode }
    });
    res.status(200).json({ conversation: publicConversation(updated) });
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
        code: 'AGENT_CONVERSATION_MESSAGE_REQUIRED',
        message: 'content is required.',
        retryable: false
      } });
    }
    const currentAgent = session.agentId
      ? await getAgentDefinition(session.workspaceId, session.agentId)
      : null;
    const revoked = pinnedAgentCapabilityRevocation(session.agentChatCapabilityCeiling || session.compiledAccessScope, currentAgent);
    if (revoked.length > 0) {
      return void res.status(409).json({ error: {
        code: 'AGENT_CHAT_CAPABILITY_REVOKED',
        message: 'A capability pinned to this conversation is no longer available. Start a new conversation.',
        retryable: false,
        details: { reasons: revoked.slice(0, 8) }
      } });
    }
    res.locals.agentConversationAuthorized = session.id;
    req.params.sessionId = session.id;
    req.body = session.launchedAt
      ? { kind: 'follow_up', content, clientRequestId: req.body?.clientRequestId }
      : { kind: 'launch', content, clientRequestId: req.body?.clientRequestId };
    await postWorkflowMessage(req, res, next);
  } catch (error) {
    next(error);
  }
}
