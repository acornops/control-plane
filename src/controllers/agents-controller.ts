import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { compileAgentRunScope, AgentAccessDeniedError } from '../services/agent-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { incrementAutomationApproval } from '../metrics.js';
import {
  createAgentRunActivity,
  createAgentDefinition,
  createAgentVersionSnapshot,
  deleteAgentDefinition,
  getAgentDefinition,
  listAgentActivityRecords,
  listAgentDefinitions,
  listAgentVersionSnapshots,
  restoreAgentVersionSnapshot,
  updateAgentDefinition
} from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import type { TargetType } from '../types/domain.js';
import { repo } from '../store/repository.js';
import { toSingleParam } from '../utils/params.js';
import { containsSearchText, makeQuerySignature, normalizeSearchQuery, pageArray, parseBoundedLimit } from '../utils/pagination.js';
import {
  agentPatch,
  agentResponse,
  badRequest,
  bodyRecord,
  collectAgentOptionErrors,
  normalizeApprovalPolicy,
  normalizeTargetScope,
  normalizeTrustPolicy,
  stringList,
  workflowsUsingAgent
} from './agent-controller-helpers.js';

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function requireAgentWorkspaceId(req: AuthenticatedRequest, res: Response): string | null {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    res.status(400).json({
      error: {
        code: 'AGENT_WORKSPACE_REQUIRED',
        message: 'workspaceId is required for workspace-scoped agent routes.',
        retryable: false
      }
    });
    return null;
  }
  return workspaceId;
}

async function auditAgentDefinitionMutation(
  req: AuthenticatedRequest,
  agent: AgentDefinition,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: agent.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorUserId: req.auth.userId,
    objectType: 'agent',
    objectId: agent.id,
    objectName: agent.name,
    summary,
    metadata: {
      agentId: agent.id,
      agentVersion: agent.version,
      status: agent.status,
      ...metadata
    }
  });
}

export async function listAgents(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === '1';
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, includeInactive, q });
    const agents = (await listAgentDefinitions(workspaceId, { includeInactive }))
      .filter((agent) => containsSearchText([agent.name, agent.description, agent.status, agent.ownerUserId], q));
    const rows = await Promise.all(agents.map(agentResponse));
    res.status(200).json(pageArray(rows, {
      limit: parseBoundedLimit(req.query.limit),
      cursor: req.query.cursor,
      signature
    }));
  } catch (err) {
    next(err);
  }
}

export async function getAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const agent = await getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    res.status(200).json({ agent: await agentResponse(agent) });
  } catch (err) {
    next(err);
  }
}

export async function createAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const body = bodyRecord(req.body);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    if (!name) {
      badRequest(res, 'AGENT_NAME_REQUIRED', 'Agent name is required.');
      return;
    }
    if (!instructions) {
      badRequest(res, 'AGENT_INSTRUCTIONS_REQUIRED', 'Agent instructions are required.');
      return;
    }
    const providerType: AgentDefinition['providerType'] = body.providerType === 'external' ? 'external' : 'internal';
    const approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy);
    const trustPolicy = normalizeTrustPolicy(body.trustPolicy, providerType);
    const targetScope = normalizeTargetScope(body.targetScope);
    const agentInput = {
      providerType,
      mcpServers: stringList(body.mcpServers),
      tools: stringList(body.tools),
      skills: stringList(body.skills),
      contextGrants: stringList(body.contextGrants),
      approvalPolicy,
      trustPolicy,
      targetScope
    };
    const optionErrors = await collectAgentOptionErrors(workspaceId, agentInput);
    if (optionErrors.length > 0) {
      badRequest(res, 'AGENT_OPTION_INVALID', 'Agent references unknown or disabled server-owned options.', optionErrors);
      return;
    }
    const agent = await createAgentDefinition({
      workspaceId,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      instructions,
      ownerUserId: typeof body.ownerUserId === 'string' ? body.ownerUserId : req.auth.userId,
      createdBy: req.auth.userId,
      providerType,
      mcpServers: agentInput.mcpServers,
      tools: agentInput.tools,
      skills: agentInput.skills,
      contextGrants: agentInput.contextGrants,
      approvalPolicy,
      trustPolicy,
      targetScope
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'agent.definition_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'agent',
      objectId: agent.id,
      objectName: agent.name,
      summary: 'Agent definition created',
      metadata: { agentId: agent.id, agentVersion: agent.version }
    });
    res.status(201).json({ agent: await agentResponse(agent) });
  } catch (err) {
    next(err);
  }
}

export async function updateAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const current = await getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    if (current.kind === 'system_orchestrator') {
      res.status(409).json({ error: { code: 'SYSTEM_ORCHESTRATOR_IMMUTABLE', message: 'The system workflow orchestrator cannot be edited.', retryable: false } });
      return;
    }
    const patch = agentPatch(bodyRecord(req.body));
    const optionErrors = await collectAgentOptionErrors(workspaceId, { ...current, ...patch });
    if (optionErrors.length > 0) {
      badRequest(res, 'AGENT_OPTION_INVALID', 'Agent references unknown or disabled server-owned options.', optionErrors);
      return;
    }
    const providerType = patch.providerType || current.providerType;
    const updated = await updateAgentDefinition(workspaceId, current.id, {
      ...patch,
      trustPolicy: patch.trustPolicy ? normalizeTrustPolicy(patch.trustPolicy, providerType) : patch.providerType === 'external' ? normalizeTrustPolicy(undefined, 'external') : undefined,
      approvalPolicy: patch.approvalPolicy ? normalizeApprovalPolicy(patch.approvalPolicy) : undefined,
      targetScope: patch.targetScope
    });
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    await auditAgentDefinitionMutation(req, updated, 'agent.definition_updated.v1', 'Agent definition updated');
    res.status(200).json({ agent: await agentResponse(updated) });
  } catch (err) {
    next(err);
  }
}

export async function deleteAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const agentId = toSingleParam(req.params.agentId);
    const current = await getAgentDefinition(workspaceId, agentId);
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    if (current.source === 'system') {
      res.status(409).json({ error: { code: 'SYSTEM_AGENT_IMMUTABLE', message: 'System agent templates cannot be deleted.', retryable: false } });
      return;
    }
    const assignedWorkflows = await workflowsUsingAgent(workspaceId, agentId);
    if (assignedWorkflows.length > 0) {
      res.status(409).json({
        error: {
          code: 'AGENT_ASSIGNED_TO_WORKFLOWS',
          message: 'Remove this agent from assigned workflows before deleting it.',
          retryable: false,
          details: { workflows: assignedWorkflows }
        }
      });
      return;
    }
    await deleteAgentDefinition(workspaceId, agentId);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'agent.definition_deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'agent',
      objectId: current.id,
      objectName: current.name,
      summary: 'Agent definition deleted',
      metadata: { agentId: current.id, agentVersion: current.version }
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function createAgentVersion(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const version = await createAgentVersionSnapshot(workspaceId, toSingleParam(req.params.agentId), req.auth.userId);
    if (!version) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const agent = await getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (agent) {
      await auditAgentDefinitionMutation(req, agent, 'agent.version_snapshot_created.v1', 'Agent version snapshot created', { snapshotId: version.id });
    }
    res.status(201).json({ version });
  } catch (err) {
    next(err);
  }
}

export async function listAgentVersions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const agent = await getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, agentId: agent.id, q });
    const rows = (await listAgentVersionSnapshots(workspaceId, agent.id))
      .filter((version) => containsSearchText([version.version, version.createdBy, version.createdAt], q));
    res.status(200).json(pageArray(rows, {
      limit: parseBoundedLimit(req.query.limit), cursor: req.query.cursor, signature
    }));
  } catch (err) {
    next(err);
  }
}

export async function restoreAgentVersion(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const restored = await restoreAgentVersionSnapshot(
      workspaceId,
      toSingleParam(req.params.agentId),
      toSingleParam(req.params.versionId)
    );
    if (!restored) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent version not found', retryable: false } });
      return;
    }
    await auditAgentDefinitionMutation(req, restored, 'agent.version_restored.v1', 'Agent version restored', {
      restoredVersionId: toSingleParam(req.params.versionId)
    });
    res.status(200).json({ agent: await agentResponse(restored) });
  } catch (err) {
    next(err);
  }
}

export async function testAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to test agents');
    if (!authz) return;
    const agent = await getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const body = bodyRecord(req.body);
    const approvedContextGrants = stringList(body.approvedContextGrants) || [];
    const compiledScope = compileAgentRunScope({
      agent,
      actor: {
        userId: req.auth.userId,
        role: authz.role,
        permissions: authz.permissions
      },
      approvedContextGrants,
      triggerId: typeof body.triggerId === 'string' ? body.triggerId : undefined
    });
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
    res.status(200).json({ compiledScope, executing: false, deprecated: true });
  } catch (err) {
    if (err instanceof AgentAccessDeniedError) {
      res.status(403).json({
        error: {
          code: err.code,
          message: err.message,
          retryable: false,
          details: {
            missingPermissions: err.missingPermissions,
            missingContextGrants: err.missingContextGrants
          }
        }
      });
      return;
    }
    next(err);
  }
}

export async function runAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const agentId = toSingleParam(req.params.agentId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId, 'No access to Agent');
    if (!authz) return;
    const agent = await getAgentDefinition(workspaceId, agentId);
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const body = bodyRecord(req.body);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      badRequest(res, 'AGENT_PROMPT_REQUIRED', 'prompt is required.');
      return;
    }
    const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : undefined;
    let targetType: TargetType | undefined;
    if (agent.targetScope.type === 'selected_target' && !targetId) {
      badRequest(res, 'AGENT_TARGET_REQUIRED', 'This Agent requires a selected target.');
      return;
    }
    if (targetId) {
      const target = await repo.getTarget(workspaceId, targetId);
      if (!target || target.status === 'offline') {
        res.status(409).json({ error: { code: 'AGENT_TARGET_NOT_READY', message: 'The selected target is missing or offline.', retryable: false } });
        return;
      }
      if (agent.targetScope.targetTypes?.length && !agent.targetScope.targetTypes.includes(target.targetType)) {
        badRequest(res, 'AGENT_TARGET_TYPE_INVALID', 'The selected target type is not allowed for this Agent.');
        return;
      }
      targetType = target.targetType;
    }
    if (agent.readiness.status === 'blocked' || (agent.id === 'agent-release-coordinator' && agent.readiness.status !== 'ready')) {
      res.status(409).json({
        error: { code: 'AGENT_NOT_READY', message: agent.readiness.reasons[0] || 'Agent prerequisites are not ready.', retryable: false,
          details: { readiness: agent.readiness } }
      });
      return;
    }
    const approvedContextGrants = stringList(body.approvedContextGrants) || [];
    const compiledScope = compileAgentRunScope({
      agent,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      approvedContextGrants,
      triggerId: typeof body.triggerId === 'string' ? body.triggerId : undefined
    });
    const activity = await createAgentRunActivity({
      agent,
      triggerId: compiledScope.triggerId,
      triggeredBy: { type: 'user', userId: req.auth.userId },
      prompt,
      inputContext: body.inputContext && typeof body.inputContext === 'object' && !Array.isArray(body.inputContext)
        ? body.inputContext as Record<string, unknown> : {},
      compiledScope,
      clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined,
      targetId,
      targetType
    });
    if (activity.status === 'waiting_for_approval') incrementAutomationApproval('pre_step', 'requested');
    await recordWorkspaceAuditEvent({
      workspaceId, category: 'run', eventType: 'agent.run_created.v1', operation: 'write',
      actorUserId: req.auth.userId, objectType: 'agent_run', objectId: activity.id,
      objectName: agent.name, summary: 'Agent run created',
      metadata: { agentId, agentVersion: agent.version, triggerId: activity.triggerId || null, targetId: targetId || null }
    });
    res.status(202).json({ runId: activity.id, activityId: activity.id, source: 'agent', status: activity.status });
  } catch (err) {
    if (err instanceof AgentAccessDeniedError) {
      res.status(403).json({ error: { code: err.code, message: err.message, retryable: false,
        details: { missingPermissions: err.missingPermissions, missingContextGrants: err.missingContextGrants } } });
      return;
    }
    next(err);
  }
}

export async function listAgentActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const agentId = toSingleParam(req.params.agentId);
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, agentId, q });
    const rows = (await listAgentActivityRecords(workspaceId, agentId))
      .filter((activity) => containsSearchText([activity.status, activity.triggeredBy.type, activity.createdAt], q));
    res.status(200).json(pageArray(rows, {
      limit: parseBoundedLimit(req.query.limit), cursor: req.query.cursor, signature
    }));
  } catch (err) {
    next(err);
  }
}
