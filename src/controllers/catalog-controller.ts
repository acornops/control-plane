import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import {
  requireTargetAccess,
  requireWorkspaceCapability,
  requireWorkspaceDataRead
} from '../auth/workspace-authorization.js';
import {
  createCatalogSource,
  getCatalogArtifact,
  importCatalogMcpServer,
  listAgentMcpServers,
  listCatalogArtifacts,
  listCatalogSources,
  listTargetMcpServers,
  toPublicMcpServerConfig
} from '../services/mcp-registry-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { targetWebhookScope } from '../services/target-webhook-scope.js';
import {
  CatalogDestinationValidationError,
  validateAgentCatalogDestination
} from '../services/catalog-destination-validator.js';
import { webhooks } from '../services/webhooks.js';
import { recordMcpServerAudit } from './workspaces/mcp-audit.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { syncAgentMcpCapabilitySnapshot, toAgentMcpServer } from '../services/agent-mcp-capabilities.js';
import { repo } from '../store/repository.js';
import { toSingleParam } from '../utils/params.js';
import {
  auditTrustBoundaryInvalidation,
  badRequest,
  forwardCatalogError,
  mapArtifact,
  mapSource,
  parseCatalogImportBody,
  trustBoundaryChanges
} from './catalog-controller-helpers.js';

export { badRequest, forwardCatalogError, mapSource };

export async function listWorkspaceCatalogSources(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const result = await listCatalogSources(workspaceId);
    res.status(200).json({
      items: result.items.map(mapSource),
      capabilities: {
        workspaceManagedSourcesEnabled: result.capabilities.workspace_managed_sources_enabled,
        supportedNetworkRoutes: result.capabilities.supported_network_routes
      }
    });
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}

export async function createWorkspaceCatalogSource(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_catalog_sources',
      'No permission to manage catalog sources'
    ))) return;
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    if (!displayName || !baseUrl) {
      badRequest(res, 'Catalog source displayName and baseUrl are required.');
      return;
    }
    if (body.networkRoute !== undefined && body.networkRoute !== 'direct') {
      badRequest(res, 'Only direct MCP registry routing is currently available.');
      return;
    }
    if (body.auth !== undefined && (!body.auth || typeof body.auth !== 'object' || Array.isArray(body.auth))) {
      badRequest(res, 'MCP registry authentication must be an object.');
      return;
    }
    const authValue = body.auth as Record<string, unknown> | undefined;
    const authType = authValue?.type ?? 'none';
    if (authType !== 'none' && authType !== 'bearer_token' && authType !== 'custom_header') {
      badRequest(res, 'MCP registry authentication type is invalid.');
      return;
    }
    const credential = typeof authValue?.credential === 'string' && authValue.credential.length > 0
      ? authValue.credential
      : undefined;
    const headerName = typeof authValue?.headerName === 'string' && authValue.headerName.trim()
      ? authValue.headerName.trim()
      : undefined;
    if (
      (authType !== 'none' && !credential)
      || (authType === 'custom_header' && !headerName)
      || (authType === 'none' && (credential || headerName))
      || (authType === 'bearer_token' && headerName)
    ) {
      badRequest(res, 'MCP registry authentication is invalid or missing its credential.');
      return;
    }
    const source = await createCatalogSource({
      workspaceId,
      displayName,
      baseUrl,
      enabled: body.enabled !== false,
      networkRoute: 'direct',
      auth: {
        type: authType,
        credential,
        headerName
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'mcp',
      eventType: 'workspace.catalog_source_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'catalog_source',
      objectId: source.id,
      objectName: source.display_name,
      summary: 'MCP registry created',
      metadata: {
        sourceId: source.id,
        adapterType: source.bindings[0]?.adapter_type,
        networkRoute: source.network_route
      }
    });
    res.status(201).json({ source: mapSource(source) });
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}

export async function listWorkspaceCatalogArtifacts(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const refresh = req.query.refresh === 'true';
    if (refresh && !authz.can('manage_catalog_sources')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No permission to synchronize catalog sources', retryable: false } });
      return;
    }
    const cursor = toSingleParam(req.query.cursor as string | string[] | undefined);
    const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const limitValue = toSingleParam(req.query.limit as string | string[] | undefined);
    const limit = limitValue && /^\d+$/.test(limitValue) ? Math.min(200, Math.max(1, Number(limitValue))) : 100;
    const page = await listCatalogArtifacts(workspaceId, {
      sourceId: toSingleParam(req.query.sourceId as string | string[] | undefined),
      search: toSingleParam(req.query.q as string | string[] | undefined),
      compatible: req.query.compatible === 'true' ? true : req.query.compatible === 'false' ? false : undefined,
      refresh,
      limit,
      offset
    });
    res.status(200).json({
      items: page.items.map(mapArtifact),
      nextCursor: page.next_cursor || undefined
    });
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}

export async function getWorkspaceCatalogArtifact(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const artifact = await getCatalogArtifact(workspaceId, toSingleParam(req.params.artifactId));
    res.status(200).json({ artifact: mapArtifact(artifact) });
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}

export async function importAgentCatalogMcpServer(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const agentId = toSingleParam(req.params.agentId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage Agents');
    if (!authz) return;
    if (!authz.can('manage_mcp')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Adding MCP capabilities requires manage_agents and manage_mcp.', retryable: false } });
      return;
    }
    const agent = await getAgentDefinition(workspaceId, agentId);
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const parsed = parseCatalogImportBody(req.body);
    if (!parsed) {
      badRequest(res, 'A catalog artifact, pinned version, and remoteEndpoint are required.');
      return;
    }
    const targetConstraints = parsed.targetConstraints || { targetTypes: [], targetIds: [] };
    await validateAgentCatalogDestination({ agent, targetConstraints, findTarget: repo.getTarget });
    const server = await importCatalogMcpServer({
      workspaceId,
      agentId,
      targetConstraints,
      ...parsed
    });
    await syncAgentMcpCapabilitySnapshot(workspaceId, agentId, req.auth.userId);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'mcp',
      eventType: 'agent.catalog_mcp_imported.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'mcp_server',
      objectId: server.id,
      objectName: server.server_name,
      summary: 'Catalog MCP server installed on Agent',
      metadata: {
        serverId: server.id,
        agentId,
        sourceId: server.catalog_source_id,
        artifactName: server.catalog_artifact_name,
        version: server.catalog_version,
        digest: server.catalog_digest
      }
    });
    res.status(201).json({ server: toAgentMcpServer(server) });
  } catch (err) {
    if (err instanceof CatalogDestinationValidationError) {
      badRequest(res, err.message);
      return;
    }
    forwardCatalogError(err, res, next);
  }
}

export async function reimportAgentCatalogMcpServer(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const agentId = toSingleParam(req.params.agentId);
    const serverId = toSingleParam(req.params.serverId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage Agents');
    if (!authz) return;
    if (!authz.can('manage_mcp')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Reimporting MCP capabilities requires manage_agents and manage_mcp.', retryable: false } });
      return;
    }
    const agent = await getAgentDefinition(workspaceId, agentId);
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const parsed = parseCatalogImportBody(req.body);
    const expectedRevision = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).expectedRevision : undefined;
    if (!parsed || typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      badRequest(res, 'A catalog artifact, pinned version, remoteEndpoint, and expectedRevision are required.');
      return;
    }
    const targetConstraints = parsed.targetConstraints || { targetTypes: [], targetIds: [] };
    await validateAgentCatalogDestination({ agent, targetConstraints, findTarget: repo.getTarget });
    const previous = (await listAgentMcpServers(workspaceId, agentId)).find((item) => item.id === serverId);
    const server = await importCatalogMcpServer({
      workspaceId,
      agentId,
      ...parsed,
      reimportServerId: serverId,
      expectedRevision
    });
    await syncAgentMcpCapabilitySnapshot(workspaceId, agentId, req.auth.userId);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'mcp',
      eventType: 'agent.catalog_mcp_reimported.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'mcp_server',
      objectId: server.id,
      objectName: server.server_name,
      summary: 'Catalog MCP server explicitly reimported on Agent',
      metadata: { agentId, version: server.catalog_version, digest: server.catalog_digest, revision: server.revision }
    });
    await auditTrustBoundaryInvalidation({
      req,
      workspaceId,
      server,
      agentId,
      changedFields: trustBoundaryChanges(previous, server)
    });
    res.status(200).json({ server: toAgentMcpServer(server) });
  } catch (err) {
    if (err instanceof CatalogDestinationValidationError) {
      badRequest(res, err.message);
      return;
    }
    forwardCatalogError(err, res, next);
  }
}

async function importTargetCatalogServer(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  reimport: boolean
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const serverId = toSingleParam(req.params.serverId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    if (!access.authz.can('manage_mcp')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Target catalog installation requires manage_mcp.', retryable: false } });
      return;
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && 'targetConstraints' in req.body) {
      badRequest(res, 'Target catalog installations do not accept Agent target constraints.');
      return;
    }
    const parsed = parseCatalogImportBody(req.body);
    const expectedRevision = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).expectedRevision : undefined;
    if (!parsed || (reimport && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1))) {
      badRequest(res, reimport
        ? 'A catalog artifact, pinned version, remoteEndpoint, and expectedRevision are required.'
        : 'A catalog artifact, pinned version, and remoteEndpoint are required.');
      return;
    }
    const { targetConstraints: _ignored, ...catalogInput } = parsed;
    const previous = reimport
      ? (await listTargetMcpServers(workspaceId, targetId, access.target.targetType)).find((item) => item.id === serverId)
      : undefined;
    const server = await importCatalogMcpServer({
      workspaceId,
      scopeType: 'target',
      targetId: access.target.id,
      targetType: access.target.targetType,
      ...catalogInput,
      ...(reimport ? { reimportServerId: serverId, expectedRevision: expectedRevision as number } : {})
    });
    const operation = reimport ? 'updated' : 'created';
    webhooks.emit({
      type: reimport ? 'mcp.server.updated.v1' : 'mcp.server.created.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'mcp_server', id: server.id },
      data: {
        serverName: server.server_name,
        serverUrl: server.server_url,
        enabled: server.enabled,
        toolCount: server.tools.length,
        reason: reimport ? 'catalog_reimport' : 'catalog_import'
      }
    });
    webhooks.emit({
      type: 'tool.catalog.changed.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'target', id: targetId },
      data: { reason: reimport ? 'catalog_mcp_reimported' : 'catalog_mcp_imported', serverId: server.id }
    });
    await recordMcpServerAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      eventType: reimport ? 'mcp.server.updated.v1' : 'mcp.server.created.v1',
      actorUserId: req.auth.userId,
      summary: `Catalog MCP server ${operation}`,
      server
    });
    await auditTrustBoundaryInvalidation({
      req,
      workspaceId,
      server,
      targetId,
      targetType: access.target.targetType,
      changedFields: trustBoundaryChanges(previous, server)
    });
    res.status(reimport ? 200 : 201).json({ server: toPublicMcpServerConfig(server) });
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}

export async function importTargetCatalogMcpServer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return importTargetCatalogServer(req, res, next, false);
}

export async function reimportTargetCatalogMcpServer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return importTargetCatalogServer(req, res, next, true);
}
