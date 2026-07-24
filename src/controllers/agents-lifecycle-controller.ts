import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability } from '../auth/workspace-authorization.js';
import { logger } from '../logger.js';
import { incrementAutomationDefinitionMutation } from '../metrics.js';
import { deleteAgentMcpServer, listAgentMcpServers } from '../services/mcp-registry-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  duplicateAgentDefinition,
  getAgentDefinition
} from '../store/repository-agents.js';
import {
  deleteAgentWithInstallationCleanup,
  listAgentWorkflowDependencies
} from '../store/repository-automation-cleanup.js';
import { toSingleParam } from '../utils/params.js';
import {
  agentResponse,
  bodyRecord,
  requireAgentWorkspaceId
} from './agent-controller-helpers.js';

export async function duplicateAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const workspaceId = requireAgentWorkspaceId(req, res);
  if (!workspaceId) return;
  const agentId = toSingleParam(req.params.agentId);
  try {
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to duplicate agents');
    if (!authz) return;
    const source = await getAgentDefinition(workspaceId, agentId);
    if (!source) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const body = bodyRecord(req.body);
    const requestedName = typeof body.name === 'string' ? body.name.trim() : undefined;
    const duplicated = await duplicateAgentDefinition(workspaceId, agentId, req.auth.userId, requestedName);
    if (!duplicated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    await recordWorkspaceAuditEvent({
      workspaceId, category: 'run', eventType: 'agent.definition_duplicated.v1', operation: 'write',
      actorUserId: req.auth.userId, objectType: 'agent', objectId: duplicated.id,
      objectName: duplicated.name, summary: 'Agent definition duplicated as a custom draft',
      metadata: { sourceAgentId: source.id, sourceAgentVersion: source.version, duplicatedAgentId: duplicated.id }
    });
    incrementAutomationDefinitionMutation('agent', 'duplication', 'success');
    logger.info({
      workspaceId, agentId: source.id, duplicatedAgentId: duplicated.id, actorUserId: req.auth.userId,
      resource: 'agent', operation: 'duplication', outcome: 'success'
    }, 'Duplicated automation definition');
    res.status(201).json({ agent: await agentResponse(duplicated) });
  } catch (error) {
    incrementAutomationDefinitionMutation('agent', 'duplication', 'failure');
    logger.error({
      err: error, workspaceId, agentId, actorUserId: req.auth.userId,
      resource: 'agent', operation: 'duplication', outcome: 'failure'
    }, 'Failed duplicating automation definition');
    next(error);
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
    const assignedWorkflows = await listAgentWorkflowDependencies(workspaceId, agentId);
    if (assignedWorkflows.length > 0) {
      res.status(409).json({ error: {
        code: 'AGENT_ASSIGNED_TO_WORKFLOWS',
        message: 'Remove this Agent from its dependent workflows before deleting it.',
        retryable: false,
        details: { workflows: assignedWorkflows }
      } });
      return;
    }
    for (const server of await listAgentMcpServers(workspaceId, agentId)) {
      await deleteAgentMcpServer(workspaceId, agentId, server.id);
    }
    const deletion = await deleteAgentWithInstallationCleanup(workspaceId, agentId);
    if (deletion.status === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    if (deletion.status === 'conflict') {
      res.status(409).json({ error: {
        code: 'AGENT_ASSIGNED_TO_WORKFLOWS',
        message: 'Remove this Agent from its dependent workflows before deleting it.',
        retryable: false,
        details: { workflows: deletion.workflows }
      } });
      return;
    }
    await recordWorkspaceAuditEvent({
      workspaceId, category: 'run', eventType: 'agent.definition_deleted.v1', operation: 'write',
      actorUserId: req.auth.userId, objectType: 'agent', objectId: current.id,
      objectName: current.name, summary: 'Agent definition deleted',
      metadata: { agentId: current.id, agentVersion: current.version }
    });
    incrementAutomationDefinitionMutation('agent', 'definition', 'success');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
