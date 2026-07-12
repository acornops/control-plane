import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { compileAgentRunScope, AgentAccessDeniedError } from '../services/agent-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { deletePersistedAgentDefinition, persistAgentDefinition } from '../store/repository-workflow-options.js';
import {
  createAgentActivityRecord,
  createAgentDefinition,
  createAgentTrigger as createStoredAgentTrigger,
  createAgentVersionSnapshot,
  deleteAgentDefinition,
  deleteAgentTrigger as deleteStoredAgentTrigger,
  getAgentDefinition,
  listAgentActivityRecords,
  listAgentDefinitions,
  listAgentVersionSnapshots,
  restoreAgentVersionSnapshot,
  updateAgentDefinition,
  updateAgentTrigger as updateStoredAgentTrigger
} from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
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
  triggerType,
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
    const rows = listAgentDefinitions(workspaceId, { includeInactive })
      .filter((agent) => containsSearchText([agent.name, agent.description, agent.status, agent.ownerUserId], q))
      .map(agentResponse);
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
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    res.status(200).json({ agent: agentResponse(agent) });
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
    const agent = createAgentDefinition({
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
    await persistAgentDefinition(agent);
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
    res.status(201).json({ agent: agentResponse(agent) });
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
    const current = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
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
    const updated = updateAgentDefinition(workspaceId, current.id, {
      ...patch,
      trustPolicy: patch.trustPolicy ? normalizeTrustPolicy(patch.trustPolicy, providerType) : patch.providerType === 'external' ? normalizeTrustPolicy(undefined, 'external') : undefined,
      approvalPolicy: patch.approvalPolicy ? normalizeApprovalPolicy(patch.approvalPolicy) : undefined,
      targetScope: patch.targetScope
    });
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    await persistAgentDefinition(updated);
    await auditAgentDefinitionMutation(req, updated, 'agent.definition_updated.v1', 'Agent definition updated');
    res.status(200).json({ agent: agentResponse(updated) });
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
    const current = getAgentDefinition(workspaceId, agentId);
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    if (current.source === 'system') {
      res.status(409).json({ error: { code: 'SYSTEM_AGENT_IMMUTABLE', message: 'System agent templates cannot be deleted.', retryable: false } });
      return;
    }
    const assignedWorkflows = workflowsUsingAgent(workspaceId, agentId);
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
    deleteAgentDefinition(workspaceId, agentId);
    await deletePersistedAgentDefinition(workspaceId, agentId);
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
    const version = createAgentVersionSnapshot(workspaceId, toSingleParam(req.params.agentId), req.auth.userId);
    if (!version) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
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
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, agentId: agent.id, q });
    const rows = listAgentVersionSnapshots(workspaceId, agent.id)
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
    const restored = restoreAgentVersionSnapshot(
      workspaceId,
      toSingleParam(req.params.agentId),
      toSingleParam(req.params.versionId)
    );
    if (!restored) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent version not found', retryable: false } });
      return;
    }
    await persistAgentDefinition(restored);
    await auditAgentDefinitionMutation(req, restored, 'agent.version_restored.v1', 'Agent version restored', {
      restoredVersionId: toSingleParam(req.params.versionId)
    });
    res.status(200).json({ agent: agentResponse(restored) });
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
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
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
    const activity = createAgentActivityRecord({
      agent,
      triggerId: compiledScope.triggerId,
      status: 'queued',
      triggeredBy: { type: 'user', userId: req.auth.userId },
      inputContext: body.inputContext && typeof body.inputContext === 'object' && !Array.isArray(body.inputContext)
        ? body.inputContext as Record<string, unknown>
        : {},
      compiledScope
    });
    res.status(202).json({ activity, compiledScope });
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

export async function listAgentActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const agentId = toSingleParam(req.params.agentId);
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, agentId, q });
    const rows = listAgentActivityRecords(workspaceId, agentId)
      .filter((activity) => containsSearchText([activity.status, activity.triggeredBy.type, activity.createdAt], q));
    res.status(200).json(pageArray(rows, {
      limit: parseBoundedLimit(req.query.limit), cursor: req.query.cursor, signature
    }));
  } catch (err) {
    next(err);
  }
}

export async function createAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agent triggers');
    if (!authz) return;
    const body = bodyRecord(req.body);
    const trigger = createStoredAgentTrigger(workspaceId, toSingleParam(req.params.agentId), {
      type: triggerType(body.type),
      enabled: body.enabled !== false,
      name: typeof body.name === 'string' ? body.name : undefined,
      schedule: body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
        ? body.schedule as { cron: string; timezone: string }
        : undefined,
      eventFilter: body.eventFilter && typeof body.eventFilter === 'object' && !Array.isArray(body.eventFilter)
        ? body.eventFilter as Record<string, unknown>
        : undefined
    });
    if (!trigger) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (agent) {
      await auditAgentDefinitionMutation(req, agent, 'agent.trigger_created.v1', 'Agent trigger created', {
        triggerId: trigger.id,
        triggerType: trigger.type,
        triggerEnabled: trigger.enabled
      });
    }
    res.status(201).json({ trigger });
  } catch (err) {
    next(err);
  }
}

export async function updateAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agent triggers');
    if (!authz) return;
    const body = bodyRecord(req.body);
    const trigger = updateStoredAgentTrigger(workspaceId, toSingleParam(req.params.agentId), toSingleParam(req.params.triggerId), {
      type: typeof body.type === 'string' ? triggerType(body.type) : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      schedule: body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
        ? body.schedule as { cron: string; timezone: string }
        : undefined,
      eventFilter: body.eventFilter && typeof body.eventFilter === 'object' && !Array.isArray(body.eventFilter)
        ? body.eventFilter as Record<string, unknown>
        : undefined
    });
    if (!trigger) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent trigger not found', retryable: false } });
      return;
    }
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (agent) {
      await auditAgentDefinitionMutation(req, agent, 'agent.trigger_updated.v1', 'Agent trigger updated', {
        triggerId: trigger.id,
        triggerType: trigger.type,
        triggerEnabled: trigger.enabled
      });
    }
    res.status(200).json({ trigger });
  } catch (err) {
    next(err);
  }
}

export async function deleteAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agent triggers');
    if (!authz) return;
    if (!deleteStoredAgentTrigger(workspaceId, toSingleParam(req.params.agentId), toSingleParam(req.params.triggerId))) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent trigger not found', retryable: false } });
      return;
    }
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (agent) {
      await auditAgentDefinitionMutation(req, agent, 'agent.trigger_deleted.v1', 'Agent trigger deleted', {
        triggerId: toSingleParam(req.params.triggerId)
      });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
