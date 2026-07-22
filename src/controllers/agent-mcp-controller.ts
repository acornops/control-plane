import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { pauseSchedulesForAgentIndividualCredentials } from '../services/agent-mcp-schedule-impact.js';
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
import type { TargetType } from '../types/domain.js';
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

const agentTargetConstraintsSchema = z.object({
  targetTypes: z.array(z.enum(['kubernetes', 'virtual_machine'])).max(16).optional(),
  targetIds: z.array(z.string().trim().min(1)).max(200).optional()
}).strict();

const agentMcpCreateSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  authType: z.enum(['none', 'bearer_token', 'custom_header']).optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  authHeaderName: z.string().min(1).optional(),
  authHeaderPrefix: z.string().optional(),
  publicHeaders: z.record(z.string(), z.string()).optional(),
  targetConstraints: agentTargetConstraintsSchema.optional()
}).strict().superRefine((value, context) => {
  const authType = value.authType || 'none';
  if (authType === 'none' && (value.authHeaderName !== undefined || value.authHeaderPrefix !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Auth header fields require authenticated MCP.' });
  }
  if (authType === 'none' && value.credentialMode && value.credentialMode !== 'none') {
    context.addIssue({ code: 'custom', message: 'Unauthenticated MCP must use credential mode none.' });
  }
  if (authType !== 'none' && value.credentialMode === 'none') {
    context.addIssue({ code: 'custom', message: 'Authenticated MCP requires workspace or individual credentials.' });
  }
  if (authType === 'custom_header' && !value.authHeaderName) {
    context.addIssue({ code: 'custom', message: 'Custom-header auth requires authHeaderName.' });
  }
});

const agentMcpUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  expectedRevision: z.number().int().min(1).optional(),
  authType: z.enum(['none', 'bearer_token', 'custom_header']).optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  authHeaderName: z.string().min(1).optional(),
  authHeaderPrefix: z.string().optional(),
  targetConstraints: agentTargetConstraintsSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one update field is required.');

const agentMcpToolUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  capability: z.enum(['read', 'write']).optional(),
  reviewState: z.enum(['pending', 'approved', 'rejected']).optional(),
  riskLevel: z.enum(['read_only', 'non_destructive_write', 'high_risk', 'destructive']).optional(),
  autoAllowed: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one update field is required.');

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
  value: z.infer<typeof agentTargetConstraintsSchema> | undefined,
  res: Response
): Promise<{ targetTypes: TargetType[]; targetIds: string[] } | null> {
  const targetTypes = value?.targetTypes || [];
  const targetIds = value?.targetIds || [];
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
    eventType: 'mcp.connections_cleanup_completed.v1',
    summary: 'MCP credentials cleaned up during uninstall',
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
    const raw = body(req);
    if (raw.credential !== undefined || raw.secretValue !== undefined || raw.secretName !== undefined) {
      return invalid(res, 'AGENT_MCP_SECRET_FORBIDDEN', 'Credentials belong to the connection endpoint, never an Agent installation.');
    }
    const parsed = agentMcpCreateSchema.safeParse(raw);
    if (!parsed.success) return invalid(res, 'AGENT_MCP_INVALID', 'Invalid Agent MCP server payload.');
    const value = parsed.data;
    const targetConstraints = await constraints(context.workspaceId, context.agent, value.targetConstraints, res);
    if (!targetConstraints) return;
    const authType = value.authType === 'custom_header' ? 'custom_header'
      : value.authType === 'bearer_token' ? 'bearer_token' : 'none';
    const credentialMode = authType === 'none'
      ? 'none'
      : value.credentialMode === 'workspace' ? 'workspace' : 'individual';
    const server = await createAgentMcpServer({
      workspaceId: context.workspaceId,
      agentId: context.agentId,
      name: value.name,
      url: value.url,
      enabled: value.enabled ?? true,
      targetConstraints,
      credentialMode,
      auth: {
        type: authType,
        headerName: value.authHeaderName,
        headerPrefix: value.authHeaderPrefix
      },
      publicHeaders: value.publicHeaders === undefined
        ? undefined
        : validateMcpPublicHeaders(value.publicHeaders)
    });
    await syncAgentMcpCapabilitySnapshot(context.workspaceId, context.agentId, req.auth.userId);
    await audit(req, { workspaceId: context.workspaceId, agentId: context.agentId, serverId: server.id, serverName: server.server_name,
      eventType: 'agent.mcp_server_created.v1', summary: 'Manual MCP server installed on Agent',
      metadata: { credentialMode } });
    res.status(201).json({ server: toAgentMcpServer(server) });
  } catch (error) { forward(error, res, next); }
}

export async function patchServer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await agentContext(req, res, true);
    if (!context) return;
    const parsed = agentMcpUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, 'AGENT_MCP_INVALID', 'Invalid Agent MCP server payload.');
    const value = parsed.data;
    const removalOnly = value.enabled === false && Object.keys(value).every((key) => key === 'enabled' || key === 'expectedRevision');
    if (!removalOnly && !context.authz.can('manage_mcp')) {
      return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Adding or reconfiguring MCP capabilities requires manage_mcp.', retryable: false } });
    }
    const targetConstraints = value.targetConstraints === undefined
      ? undefined
      : await constraints(context.workspaceId, context.agent, value.targetConstraints, res);
    if (targetConstraints === null) return;
    const authType = value.authType === 'custom_header' ? 'custom_header'
      : value.authType === 'bearer_token' ? 'bearer_token'
        : value.authType === 'none' ? 'none' : undefined;
    const credentialMode = value.credentialMode === 'workspace'
      ? 'workspace'
      : value.credentialMode === 'individual'
        ? 'individual'
        : value.credentialMode === 'none' ? 'none' : undefined;
    const serverId = toSingleParam(req.params.serverId);
    const previousServer = credentialMode === 'individual'
      ? (await listAgentMcpServers(context.workspaceId, context.agentId)).find((item) => item.id === serverId)
      : undefined;
    const server = await updateAgentMcpServer({
      workspaceId: context.workspaceId,
      agentId: context.agentId,
      serverId,
      name: value.name,
      enabled: value.enabled,
      expectedRevision: value.expectedRevision,
      targetConstraints,
      auth: authType ? {
        type: authType,
        headerName: value.authHeaderName,
        headerPrefix: value.authHeaderPrefix
      } : undefined,
      credentialMode
    });
    if (credentialMode === 'individual' && previousServer?.credential_mode === 'workspace') {
      await pauseSchedulesForAgentIndividualCredentials({
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        serverId: server.id,
        serverName: server.server_name,
        actorUserId: req.auth.userId
      });
    }
    await syncAgentMcpCapabilitySnapshot(context.workspaceId, context.agentId, req.auth.userId);
    await audit(req, { workspaceId: context.workspaceId, agentId: context.agentId, serverId: server.id, serverName: server.server_name,
      eventType: 'agent.mcp_server_updated.v1', summary: 'Agent MCP server updated',
      metadata: { revision: server.revision, credentialMode: server.credential_mode } });
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
          code: 'MCP_CONNECTION_REQUIRED',
          message: 'Use the connection Verify operation for authenticated MCP servers.',
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
    const parsed = agentMcpToolUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, 'AGENT_MCP_TOOL_INVALID', 'Invalid Agent MCP tool payload.');
    const value = parsed.data;
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
        enabled: value.enabled,
        capability: value.capability,
        reviewState: value.reviewState,
        riskLevel: value.riskLevel,
        autoAllowed: value.autoAllowed
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
