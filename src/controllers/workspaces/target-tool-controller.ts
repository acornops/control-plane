import { NextFunction, Response } from 'express';
import { agentGateway } from '../../agent/ws-server.js';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import { composeTargetToolsCatalog } from '../../services/kubernetes-cluster-tools-catalog.js';
import {
  createTargetMcpServer,
  deleteTargetMcpServer,
  LlmGatewayHttpError,
  listTargetMcpServers as listGatewayTargetMcpServers,
  listTargetMcpTools,
  testTargetMcpServerConnection,
  updateTargetMcpServer,
  updateTargetTool
} from '../../services/mcp-registry-client.js';
import { pageInMemory } from '../../services/snapshot-listing.js';
import { targetWebhookScope } from '../../services/target-webhook-scope.js';
import { webhooks } from '../../services/webhooks.js';
import { repo } from '../../store/repository.js';
import { TargetType } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import {
  containsSearchText,
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../../utils/pagination.js';
import { mapGatewayError } from './common.js';
import {
  recordMcpServerAudit,
  recordMcpServerDeletedAudit,
  recordMcpServerTestAudit,
  recordToolCatalogAudit
} from './mcp-audit.js';

function respondMissingMcpCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with MCP management capability can modify MCP server settings',
      retryable: false
    }
  });
}

function respondMissingToolsCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with tool management capability can modify tool settings',
      retryable: false
    }
  });
}

export async function listTargetMcpCatalog(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    const [tools, servers, overrides, agentRegistration, targetAgentConnected] = await Promise.all([
      listTargetMcpTools(workspaceId, targetId, access.target.targetType, {
        includeServerDisabled: true,
        includeDisabled: true
      }),
      listGatewayTargetMcpServers(workspaceId, targetId, access.target.targetType),
      repo.listTargetToolOverrides(targetId),
      repo.getTargetAgentRegistration(targetId),
      agentGateway.isAgentConnected(targetId)
    ]);
    const catalog = composeTargetToolsCatalog({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      canEdit: access.authz.can('manage_mcp'),
      tools,
      servers,
      overrides,
      targetSupportsWrite: Boolean(agentRegistration?.capabilities?.includes('write')),
      targetAgentConnected
    });
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ q });
    const cursor = decodeCursor<{ offset?: number; signature: string }>(req.query.cursor, signature);
    const filteredServers = catalog.servers
      .map((server) => ({
        ...server,
        tools: server.tools.filter((tool) =>
          containsSearchText([server.name, server.url, tool.name, tool.description], q)
        )
      }))
      .filter((server) => !q || containsSearchText([server.name, server.url], q) || server.tools.length > 0);
    const page = pageInMemory(filteredServers, parseBoundedLimit(req.query.limit), cursor, signature);
    res.status(200).json({ ...catalog, servers: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function listTargetMcpServers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }

    const servers = await listGatewayTargetMcpServers(workspaceId, targetId, access.target.targetType);
    res.status(200).json(servers);
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function listTargetMcpServerTools(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const serverId = toSingleParam(req.params.serverId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }

    const [tools, servers, overrides, agentRegistration, targetAgentConnected] = await Promise.all([
      listTargetMcpTools(workspaceId, targetId, access.target.targetType, {
        includeServerDisabled: true,
        includeDisabled: true
      }),
      listGatewayTargetMcpServers(workspaceId, targetId, access.target.targetType),
      repo.listTargetToolOverrides(targetId),
      repo.getTargetAgentRegistration(targetId),
      agentGateway.isAgentConnected(targetId)
    ]);
    const catalog = composeTargetToolsCatalog({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      canEdit: access.authz.can('manage_mcp'),
      tools,
      servers,
      overrides,
      targetSupportsWrite: Boolean(agentRegistration?.capabilities?.includes('write')),
      targetAgentConnected
    });
    const server = catalog.servers.find((item) => item.id === serverId);
    if (!server) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
      return;
    }

    const q = normalizeSearchQuery(req.query.q);
    const capability = toSingleParam(req.query.capability as string | string[] | undefined);
    const enabled = toSingleParam(req.query.enabled as string | string[] | undefined);
    const filters = {
      q,
      capability: capability === 'read' || capability === 'write' ? capability : undefined,
      enabled: enabled === 'true' || enabled === 'false' ? enabled : undefined
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ offset?: number; signature: string }>(req.query.cursor, signature);
    const filteredTools = server.tools.filter((tool) => {
      if (filters.capability && tool.capability !== filters.capability) return false;
      if (filters.enabled && String(tool.enabledEffective) !== filters.enabled) return false;
      return containsSearchText([tool.name, tool.description], q);
    });
    res.status(200).json(pageInMemory(filteredTools, parseBoundedLimit(req.query.limit), cursor, signature));
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function createTargetMcpServerForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_mcp')) {
      respondMissingMcpCapability(res);
      return;
    }

    const server = await createTargetMcpServer({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      name: req.body.name,
      url: req.body.url,
      enabled: req.body.enabled,
      publicHeaders: req.body.publicHeaders,
      auth: req.body.auth
    });

    webhooks.emit({
      type: 'mcp.server.created.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'mcp_server', id: server.id },
      data: {
        serverName: server.server_name,
        serverUrl: server.server_url,
        enabled: server.enabled,
        toolCount: server.tools.length
      }
    });
    webhooks.emit({
      type: 'tool.catalog.changed.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'target', id: targetId },
      data: {
        reason: 'mcp_server_created',
        serverId: server.id
      }
    });
    await recordMcpServerAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      eventType: 'mcp.server.created.v1',
      actorUserId: req.auth.userId,
      summary: 'MCP server created',
      server
    });
    res.status(201).json(server);
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function updateTargetMcpServerForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const serverId = toSingleParam(req.params.serverId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_mcp')) {
      respondMissingMcpCapability(res);
      return;
    }

    const server = await updateTargetMcpServer({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      serverId,
      name: req.body.name,
      enabled: req.body.enabled,
      publicHeaders: req.body.publicHeaders,
      auth: req.body.auth,
      tools: req.body.tools,
      removeTools: req.body.removeTools
    });

    webhooks.emit({
      type: 'mcp.server.updated.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'mcp_server', id: server.id },
      data: {
        serverName: server.server_name,
        serverUrl: server.server_url,
        enabled: server.enabled,
        toolCount: server.tools.length
      }
    });
    webhooks.emit({
      type: 'tool.catalog.changed.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'target', id: targetId },
      data: {
        reason: 'mcp_server_updated',
        serverId: server.id
      }
    });
    await recordMcpServerAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      eventType: 'mcp.server.updated.v1',
      actorUserId: req.auth.userId,
      summary: 'MCP server updated',
      server
    });
    res.status(200).json(server);
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function deleteTargetMcpServerForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const serverId = toSingleParam(req.params.serverId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_mcp')) {
      respondMissingMcpCapability(res);
      return;
    }

    await deleteTargetMcpServer(workspaceId, targetId, access.target.targetType, serverId);
    webhooks.emit({
      type: 'mcp.server.deleted.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'mcp_server', id: serverId },
      data: {
        deletedBy: req.auth.userId
      }
    });
    webhooks.emit({
      type: 'tool.catalog.changed.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'target', id: targetId },
      data: {
        reason: 'mcp_server_deleted',
        serverId
      }
    });
    await recordMcpServerDeletedAudit(workspaceId, targetId, access.target.targetType, req.auth.userId, serverId);
    res.status(204).send();
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function testTargetMcpServerConnectionForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const serverId = toSingleParam(req.params.serverId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_mcp')) {
      respondMissingMcpCapability(res);
      return;
    }

    const testResult = await testTargetMcpServerConnection(workspaceId, targetId, access.target.targetType, serverId);
    webhooks.emit({
      type: 'mcp.server.tested.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'mcp_server', id: serverId },
      data: {
        serverName: testResult.server_name,
        serverUrl: testResult.server_url,
        connectionStatus: testResult.connection_status,
        discoveredToolCount: testResult.discovered_tool_count,
        error: testResult.error || null
      }
    });
    await recordMcpServerTestAudit(workspaceId, targetId, access.target.targetType, req.auth.userId, serverId, testResult);
    res.status(200).json(testResult);
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function updateTargetMcpServerToolSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const serverId = toSingleParam(req.params.serverId);
    const toolName = toSingleParam(req.params.toolName);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_tools')) {
      respondMissingToolsCapability(res);
      return;
    }

    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'enabled is required', retryable: false } });
      return;
    }
    const [tools, servers] = await Promise.all([
      listTargetMcpTools(workspaceId, targetId, access.target.targetType, {
        includeServerDisabled: true,
        includeDisabled: true
      }),
      listGatewayTargetMcpServers(workspaceId, targetId, access.target.targetType)
    ]);
    const server = servers.find((item) => item.id === serverId);
    if (!server) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
      return;
    }
    const existing = tools.find((tool) => tool.name === toolName && tool.mcp_server_url === server.server_url);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found', retryable: false } });
      return;
    }
    const requestedCapability = req.body?.capability;
    const capability = requestedCapability === 'write' || requestedCapability === 'read'
      ? requestedCapability
      : existing.capability === 'write'
        ? 'write'
        : 'read';
    if (req.body.enabled && existing.source === 'mcp' && !existing.enabled && requestedCapability !== capability) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'capability is required when enabling a discovered MCP tool',
          retryable: false
        }
      });
      return;
    }
    const updated = await updateTargetTool(workspaceId, targetId, access.target.targetType, toolName, {
      enabled: req.body.enabled,
      capability
    });
    await repo.setTargetToolOverride(targetId, toolName, req.body.enabled);
    webhooks.emit({
      type: 'tool.catalog.changed.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'target', id: targetId },
      data: {
        reason: 'mcp_tool_setting_updated',
        serverId,
        toolName,
        enabled: req.body.enabled
      }
    });
    await recordToolCatalogAudit(workspaceId, targetId, access.target.targetType, req.auth.userId, toolName, req.body.enabled, capability);
    res.status(200).json({
      ...updated,
      enabled: req.body.enabled
    });
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
