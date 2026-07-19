import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import {
  createAgentMcpServer,
  deleteAgentMcpServer,
  listAgentMcpServers,
  LlmGatewayHttpError,
  testAgentMcpServerConnection,
  updateAgentMcpServer,
  updateAgentMcpTool
} from '../services/mcp-registry-client.js';
import { syncAgentMcpCapabilitySnapshot, toAgentMcpServer } from '../services/agent-mcp-capabilities.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  InvalidMcpPublicHeadersError,
  validateMcpPublicHeaders
} from '../services/mcp-public-header-policy.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { repo } from '../store/repository.js';
import { isTargetType, type TargetType } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

function forward(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof InvalidMcpPublicHeadersError) {
    invalid(res, error.code, error.message);
    return;
  }
  if (error instanceof LlmGatewayHttpError) {
    const mapped = mapGatewayError(error, { upstreamMessage: 'Agent MCP service is unavailable' });
    res.status(mapped.status).json(mapped.body);
    return;
  }
  next(error);
}

function body(req: AuthenticatedRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function invalid(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message, retryable: false } });
}

async function agentContext(req: AuthenticatedRequest, res: Response, write = false) {
  const workspaceId = toSingleParam(req.params.workspaceId);
  const authz = write
    ? await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage Agent capabilities')
    : await requireWorkspaceDataRead(req, res, workspaceId);
  if (!authz) return null;
  const agentId = toSingleParam(req.params.agentId);
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
    return null;
  }
  return { workspaceId, agentId, agent, authz };
}

async function constraints(
  workspaceId: string,
  agent: Awaited<ReturnType<typeof getAgentDefinition>> & {},
  value: unknown,
  res: Response
): Promise<{ targetTypes: TargetType[]; targetIds: string[] } | null> {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const targetTypes = Array.isArray(raw.targetTypes)
    ? raw.targetTypes.filter((entry): entry is TargetType => typeof entry === 'string' && isTargetType(entry))
    : [];
  const targetIds = Array.isArray(raw.targetIds)
    ? raw.targetIds.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())
    : [];
  if (agent.targetScope.targetTypes?.length && targetTypes.some((type) => !agent.targetScope.targetTypes?.includes(type))) {
    invalid(res, 'AGENT_MCP_TARGET_CONSTRAINT_INVALID', 'Target type constraints must stay within the Agent target scope.');
    return null;
  }
  if (agent.targetScope.targetIds?.length && targetIds.some((id) => !agent.targetScope.targetIds?.includes(id))) {
    invalid(res, 'AGENT_MCP_TARGET_CONSTRAINT_INVALID', 'Target ID constraints must stay within the Agent target scope.');
    return null;
  }
  for (const targetId of targetIds) {
    if (!(await repo.getTarget(workspaceId, targetId))) {
      invalid(res, 'AGENT_MCP_TARGET_CONSTRAINT_INVALID', `Unknown target ID: ${targetId}`);
      return null;
    }
  }
  return { targetTypes: [...new Set(targetTypes)], targetIds: [...new Set(targetIds)] };
}

async function audit(req: AuthenticatedRequest, input: {
  workspaceId: string; agentId: string; serverId: string; serverName: string; eventType: string; summary: string;
  metadata?: Record<string, unknown>;
}) {
  await recordWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'mcp',
    eventType: input.eventType,
    operation: 'write',
    actorUserId: req.auth.userId,
    objectType: 'mcp_server',
    objectId: input.serverId,
    objectName: input.serverName,
    summary: input.summary,
    metadata: { agentId: input.agentId, ...input.metadata }
  });
}

async function auditConnectionCleanup(req: AuthenticatedRequest, input: {
  workspaceId: string; agentId: string; serverId: string; serverName: string;
}) {
  await audit(req, {
    ...input,
    eventType: 'mcp.personal_connections_cleanup_completed.v1',
    summary: 'Personal MCP credentials cleaned up during uninstall',
    metadata: { credentialCleanup: 'completed' }
  });
}

export async function listServers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res);
    if (!context) return;
    const servers = await listAgentMcpServers(context.workspaceId, context.agentId);
    res.status(200).json({ items: servers.map(toAgentMcpServer) });
  } catch (error) { forward(error, res, next); }
}


export async function createServer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res, true);
    if (!context) return;
    if (!context.authz.can('manage_mcp')) {
      return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Adding MCP capabilities requires manage_agents and manage_mcp.', retryable: false } });
    }
    if (context.agent.kind === 'manager') {
      return invalid(res, 'MANAGER_OPERATIONAL_CAPABILITY_FORBIDDEN', 'Managers can use coordination functions only.');
    }
    const value = body(req);
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    if (!name || !url) return invalid(res, 'AGENT_MCP_INVALID', 'name and url are required.');
    if (value.credential !== undefined || value.secretValue !== undefined || value.secretName !== undefined) {
      return invalid(res, 'AGENT_MCP_SECRET_FORBIDDEN', 'Provider PATs belong to a user connection, never an Agent installation.');
    }
    const targetConstraints = await constraints(context.workspaceId, context.agent, value.targetConstraints, res);
    if (!targetConstraints) return;
    const authType = value.authType === 'custom_header' ? 'custom_header'
      : value.authType === 'bearer_token' ? 'bearer_token' : 'none';
    const authScope = authType === 'none' ? 'none' : 'personal';
    const server = await createAgentMcpServer({
      workspaceId: context.workspaceId,
      agentId: context.agentId,
      name,
      url,
      enabled: value.enabled !== false,
      targetConstraints,
      authScope,
      auth: {
        type: authType,
        headerName: typeof value.authHeaderName === 'string' ? value.authHeaderName : undefined,
        headerPrefix: typeof value.authHeaderPrefix === 'string' ? value.authHeaderPrefix : undefined
      },
      publicHeaders: value.publicHeaders === undefined
        ? undefined
        : value.publicHeaders && typeof value.publicHeaders === 'object' && !Array.isArray(value.publicHeaders)
          ? validateMcpPublicHeaders(value.publicHeaders as Record<string, unknown>)
          : (() => { throw new InvalidMcpPublicHeadersError('publicHeaders must be an object'); })()
    });
    await syncAgentMcpCapabilitySnapshot(context.workspaceId, context.agentId, req.auth.userId);
    await audit(req, { workspaceId: context.workspaceId, agentId: context.agentId, serverId: server.id, serverName: server.server_name,
      eventType: 'agent.mcp_server_created.v1', summary: 'Manual MCP server installed on Agent' });
    res.status(201).json({ server: toAgentMcpServer(server) });
  } catch (error) { forward(error, res, next); }
}

export async function patchServer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res, true);
    if (!context) return;
    const value = body(req);
    const removalOnly = value.enabled === false && Object.keys(value).every((key) => key === 'enabled' || key === 'expectedRevision');
    if (!removalOnly && !context.authz.can('manage_mcp')) {
      return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Adding or reconfiguring MCP capabilities requires manage_mcp.', retryable: false } });
    }
    const targetConstraints = value.targetConstraints === undefined
      ? undefined
      : await constraints(context.workspaceId, context.agent, value.targetConstraints, res);
    if (targetConstraints === null) return;
    const server = await updateAgentMcpServer({
      workspaceId: context.workspaceId,
      agentId: context.agentId,
      serverId: toSingleParam(req.params.serverId),
      name: typeof value.name === 'string' ? value.name.trim() : undefined,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
      expectedRevision: typeof value.expectedRevision === 'number' ? value.expectedRevision : undefined,
      targetConstraints
    });
    await syncAgentMcpCapabilitySnapshot(context.workspaceId, context.agentId, req.auth.userId);
    await audit(req, { workspaceId: context.workspaceId, agentId: context.agentId, serverId: server.id, serverName: server.server_name,
      eventType: 'agent.mcp_server_updated.v1', summary: 'Agent MCP server updated', metadata: { revision: server.revision } });
    res.status(200).json({ server: toAgentMcpServer(server) });
  } catch (error) { forward(error, res, next); }
}

export async function removeServer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res, true);
    if (!context) return;
    const serverId = toSingleParam(req.params.serverId);
    const server = (await listAgentMcpServers(context.workspaceId, context.agentId)).find((item) => item.id === serverId);
    if (!server) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
    await deleteAgentMcpServer(context.workspaceId, context.agentId, serverId);
    await syncAgentMcpCapabilitySnapshot(context.workspaceId, context.agentId, req.auth.userId);
    await audit(req, { workspaceId: context.workspaceId, agentId: context.agentId, serverId, serverName: server.server_name,
      eventType: 'agent.mcp_server_deleted.v1', summary: 'MCP server removed from Agent', metadata: { credentialCleanup: 'completed' } });
    await auditConnectionCleanup(req, { workspaceId: context.workspaceId, agentId: context.agentId, serverId, serverName: server.server_name });
    res.status(204).end();
  } catch (error) { forward(error, res, next); }
}

export async function testServer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res, true);
    if (!context) return;
    if (!context.authz.can('manage_mcp')) return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool discovery requires manage_mcp.', retryable: false } });
    const serverId = toSingleParam(req.params.serverId);
    const server = (await listAgentMcpServers(context.workspaceId, context.agentId)).find((item) => item.id === serverId);
    if (!server) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
    if (server.auth_type !== 'none') {
      return void res.status(409).json({
        error: {
          code: 'MCP_PERSONAL_CONNECTION_REQUIRED',
          message: 'Use the personal connection Verify operation for authenticated MCP servers.',
          retryable: false
        }
      });
    }
    const result = await testAgentMcpServerConnection(context.workspaceId, context.agentId, serverId);
    await syncAgentMcpCapabilitySnapshot(context.workspaceId, context.agentId, req.auth.userId);
    res.status(200).json({ result });
  } catch (error) { forward(error, res, next); }
}

export async function listTools(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res);
    if (!context) return;
    const serverId = toSingleParam(req.params.serverId);
    const server = (await listAgentMcpServers(context.workspaceId, context.agentId)).find((item) => item.id === serverId);
    if (!server) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
    res.status(200).json({ items: toAgentMcpServer(server).tools });
  } catch (error) { forward(error, res, next); }
}

export async function patchTool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res, true);
    if (!context) return;
    const value = body(req);
    const removalOnly = value.enabled === false && Object.keys(value).every((key) => key === 'enabled');
    if (!removalOnly && !context.authz.can('manage_mcp')) {
      return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool review and enablement require manage_mcp.', retryable: false } });
    }
    const tool = await updateAgentMcpTool(
      context.workspaceId,
      context.agentId,
      toSingleParam(req.params.serverId),
      toSingleParam(req.params.toolName),
      {
        enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
        capability: value.capability === 'read' || value.capability === 'write' ? value.capability : undefined,
        reviewState: value.reviewState === 'pending' || value.reviewState === 'approved' || value.reviewState === 'rejected' ? value.reviewState : undefined,
        riskLevel: value.riskLevel === 'read_only' || value.riskLevel === 'non_destructive_write' || value.riskLevel === 'high_risk' || value.riskLevel === 'destructive' ? value.riskLevel : undefined,
        autoAllowed: typeof value.autoAllowed === 'boolean' ? value.autoAllowed : undefined
      }
    );
    await syncAgentMcpCapabilitySnapshot(context.workspaceId, context.agentId, req.auth.userId);
    await audit(req, { workspaceId: context.workspaceId, agentId: context.agentId, serverId: tool.server_id, serverName: tool.server_id,
      eventType: 'agent.mcp_tool_reviewed.v1', summary: 'Agent MCP tool review updated', metadata: {
        toolName: tool.name, reviewState: tool.review_state, riskLevel: tool.risk_level, autoAllowed: tool.auto_allowed
      } });
    res.status(200).json({ tool });
  } catch (error) { forward(error, res, next); }
}
