import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { config } from '../config.js';
import { isAgentTargetsMcpInstallation } from '../services/agent-targets-mcp-catalog.js';
import { normalizeAgentTargetAccessPolicy } from '../services/agent-target-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { getAgentDefinition, updateAgentTargetAccessPolicy } from '../store/repository-agents.js';
import { listWorkspaceTargetSnapshot } from '../store/repository-targets.js';
import { toSingleParam } from '../utils/params.js';

const targetAccessPolicySchema = z.object({
  mode: z.enum(['all', 'allowlist', 'denylist']),
  targetIds: z.array(z.string().trim().min(1).max(256)).max(1000)
}).strict();

async function context(req: AuthenticatedRequest, res: Response, write = false) {
  const workspaceId = toSingleParam(req.params.workspaceId);
  const authz = write
    ? await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage Agent target access')
    : await requireWorkspaceDataRead(req, res, workspaceId);
  if (!authz) return null;
  if (write && !authz.can('manage_mcp')) {
    res.status(403).json({ error: {
      code: 'FORBIDDEN',
      message: 'Managing Targets MCP settings requires manage_agents and manage_mcp.',
      retryable: false
    } });
    return null;
  }
  const agentId = toSingleParam(req.params.agentId);
  const serverId = toSingleParam(req.params.serverId);
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
    return null;
  }
  const installation = agent.mcpInstallations.find((candidate) => (
    candidate.id === serverId
    && isAgentTargetsMcpInstallation(candidate, config.BUILTIN_TARGET_MCP_SERVER_URL)
  ));
  if (!installation) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Targets MCP server not found', retryable: false } });
    return null;
  }
  return { workspaceId, agentId, serverId, agent, installation };
}

async function responseBody(workspaceId: string, policy: NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>>['targetAccessPolicy']) {
  const targets = await listWorkspaceTargetSnapshot(workspaceId);
  const targetIds = new Set(targets.map((target) => target.id));
  const normalizedPolicy = normalizeAgentTargetAccessPolicy(policy);
  return {
    policy: normalizedPolicy.mode === 'all'
      ? normalizedPolicy
      : {
          ...normalizedPolicy,
          targetIds: normalizedPolicy.targetIds.filter((targetId) => targetIds.has(targetId))
        },
    targets: targets.map((target) => ({
      id: target.id,
      name: target.name,
      targetType: target.targetType,
      status: target.status
    }))
  };
}

export async function getTargetAccess(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const resolved = await context(req, res);
    if (!resolved) return;
    res.status(200).json(await responseBody(resolved.workspaceId, resolved.agent.targetAccessPolicy));
  } catch (error) {
    next(error);
  }
}

export async function putTargetAccess(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const resolved = await context(req, res, true);
    if (!resolved) return;
    const parsed = targetAccessPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'AGENT_TARGET_ACCESS_INVALID', message: 'Invalid target access policy.', retryable: false } });
      return;
    }
    const policy = normalizeAgentTargetAccessPolicy(parsed.data);
    const targets = await listWorkspaceTargetSnapshot(resolved.workspaceId);
    const targetIds = new Set(targets.map((target) => target.id));
    const unknownTargetIds = policy.targetIds.filter((targetId) => !targetIds.has(targetId));
    if (unknownTargetIds.length > 0) {
      res.status(400).json({ error: {
        code: 'AGENT_TARGET_ACCESS_TARGET_INVALID',
        message: 'Target access policy contains targets outside this workspace.',
        retryable: false,
        details: { targetIds: unknownTargetIds }
      } });
      return;
    }
    const updated = await updateAgentTargetAccessPolicy(resolved.workspaceId, resolved.agentId, policy);
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    await recordWorkspaceAuditEvent({
      workspaceId: resolved.workspaceId,
      category: 'mcp',
      eventType: 'agent.targets_mcp_access_updated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'mcp_server',
      objectId: resolved.serverId,
      objectName: resolved.installation.name,
      summary: 'Agent Targets MCP access updated',
      metadata: { agentId: resolved.agentId, mode: policy.mode, targetCount: policy.targetIds.length }
    });
    res.status(200).json(await responseBody(resolved.workspaceId, updated.targetAccessPolicy));
  } catch (error) {
    next(error);
  }
}
