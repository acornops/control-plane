import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import type { WorkspaceCapability } from '../auth/authorization.js';
import {
  requireTargetAccess,
  requireWorkspaceDataRead
} from '../auth/workspace-authorization.js';
import {
  deleteMcpUserConnection,
  getMcpUserConnection,
  listAgentMcpServers,
  listTargetMcpServers,
  LlmGatewayHttpError,
  type McpServerConfig,
  type McpUserConnectionConfig,
  upsertMcpUserConnection,
  verifyMcpUserConnection
} from '../services/mcp-registry-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

function mapConnection(connection: McpUserConnectionConfig) {
  return {
    serverId: connection.server_id,
    status: connection.status,
    authType: connection.auth_type,
    action: connection.action || undefined,
    ...(connection.error_code ? { errorCode: connection.error_code } : {})
  };
}

function forwardGatewayError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof LlmGatewayHttpError) {
    const mapped = mapGatewayError(err, { upstreamMessage: 'MCP connection service is unavailable' });
    if (mapped.status === 429 && err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
    res.status(mapped.status).json(mapped.body);
    return;
  }
  next(err);
}

function canRunWithMcp(authz: { can(capability: WorkspaceCapability): boolean }): boolean {
  return authz.can('create_sessions')
    || authz.can('create_read_only_runs')
    || authz.can('create_read_write_runs');
}

async function requirePersonalServer(
  req: AuthenticatedRequest,
  res: Response,
  mutation = false
): Promise<{ workspaceId: string; server: McpServerConfig } | null> {
  const workspaceId = toSingleParam(req.params.workspaceId);
  const serverId = toSingleParam(req.params.serverId);
  const targetId = toSingleParam(req.params.targetId);
  const agentId = toSingleParam(req.params.agentId);
  let servers: McpServerConfig[];
  if (agentId) {
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return null;
    if (mutation && !canRunWithMcp(authz)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Connecting an Agent MCP PAT requires a run capability.',
          retryable: false
        }
      });
      return null;
    }
    servers = await listAgentMcpServers(workspaceId, agentId);
  } else if (targetId) {
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return null;
    if (mutation && !canRunWithMcp(access.authz)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Connecting a target MCP PAT requires a run capability.',
          retryable: false
        }
      });
      return null;
    }
    servers = await listTargetMcpServers(workspaceId, access.target.id, access.target.targetType);
  } else {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false }
    });
    return null;
  }
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false }
    });
    return null;
  }
  if (server.auth_scope !== 'personal') {
    res.status(409).json({
      error: {
        code: 'MCP_PERSONAL_CONNECTION_NOT_REQUIRED',
        message: 'This MCP installation does not use a personal connection.',
        retryable: false
      }
    });
    return null;
  }
  return { workspaceId, server };
}

export async function getPersonalMcpConnection(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requirePersonalServer(req, res);
    if (!context) return;
    const connection = await getMcpUserConnection(
      context.workspaceId,
      context.server.id,
      req.auth.userId
    );
    res.status(200).json({ connection: mapConnection(connection) });
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}

export async function putPersonalMcpConnection(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requirePersonalServer(req, res, true);
    if (!context) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const unexpectedFields = Object.keys(body).filter(
      (key) => key !== 'credential' && key !== 'consentGranted'
    );
    const credential = typeof body.credential === 'string' ? body.credential : '';
    if (
      credential.length === 0
      || Buffer.byteLength(credential, 'utf8') > 8192
      || /[\u0000-\u001f\u007f-\u009f]/u.test(credential)
      || unexpectedFields.length > 0
    ) {
      res.status(400).json({
        error: {
          code: 'MCP_PAT_CONNECTION_INVALID',
          message: 'Only credential and consentGranted are accepted.',
          retryable: false
        }
      });
      return;
    }
    if (body.consentGranted !== true) {
      res.status(400).json({
        error: {
          code: 'MCP_CONNECTION_CONSENT_REQUIRED',
          message: 'Explicit workspace consent is required before saving this PAT.',
          retryable: false
        }
      });
      return;
    }
    const connection = await upsertMcpUserConnection({
      workspaceId: context.workspaceId,
      serverId: context.server.id,
      userId: req.auth.userId,
      credential,
      consentGranted: true
    });
    await recordWorkspaceAuditEvent({
      workspaceId: context.workspaceId,
      category: 'mcp',
      eventType: 'mcp.personal_connection_connected.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'mcp_server',
      objectId: context.server.id,
      objectName: context.server.server_name,
      summary: 'Personal MCP PAT connected or replaced',
      metadata: {
        status: connection.status,
        scopeType: context.server.scope_type,
        authType: connection.auth_type
      }
    });
    res.status(200).json({ connection: mapConnection(connection) });
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}

export async function verifyPersonalMcpConnection(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requirePersonalServer(req, res, true);
    if (!context) return;
    const connection = await verifyMcpUserConnection(
      context.workspaceId,
      context.server.id,
      req.auth.userId
    );
    await recordWorkspaceAuditEvent({
      workspaceId: context.workspaceId,
      category: 'mcp',
      eventType: 'mcp.personal_connection_verified.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'mcp_server',
      objectId: context.server.id,
      objectName: context.server.server_name,
      summary: 'Personal MCP PAT verification retried',
      metadata: {
        status: connection.status,
        scopeType: context.server.scope_type,
        authType: connection.auth_type
      }
    });
    res.status(200).json({ connection: mapConnection(connection) });
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}

export async function deletePersonalMcpConnection(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requirePersonalServer(req, res, true);
    if (!context) return;
    await deleteMcpUserConnection(context.workspaceId, context.server.id, req.auth.userId);
    await recordWorkspaceAuditEvent({
      workspaceId: context.workspaceId,
      category: 'mcp',
      eventType: 'mcp.personal_connection_disconnected.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'mcp_server',
      objectId: context.server.id,
      objectName: context.server.server_name,
      summary: 'Personal MCP PAT disconnected',
      metadata: { scopeType: context.server.scope_type }
    });
    res.status(204).end();
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}
