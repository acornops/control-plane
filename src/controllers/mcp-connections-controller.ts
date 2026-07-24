import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuthorization } from '../auth/workspace-authorization.js';
import {
  requireTargetAccess,
  requireWorkspaceDataRead
} from '../auth/workspace-authorization.js';
import {
  deleteMcpConnection,
  getMcpConnection,
  listAgentMcpServers,
  listTargetMcpServers,
  LlmGatewayHttpError,
  type McpConnectionConfig,
  type McpServerConfig,
  upsertMcpConnection,
  verifyMcpConnection
} from '../services/mcp-registry-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

const INSTALLATION_OWNER_ID = 'installation';

type ConnectionContext = {
  workspaceId: string;
  server: McpServerConfig;
  authz: WorkspaceAuthorization;
  ownerType: 'installation' | 'user';
  ownerId: string;
  canManage: boolean;
};

function mapConnection(connection: McpConnectionConfig, canManage: boolean) {
  return {
    serverId: connection.server_id,
    credentialMode: connection.credential_mode,
    status: connection.status,
    managementScope: connection.credential_mode === 'workspace' ? 'workspace' : 'individual',
    canManage,
    authType: connection.auth_type,
    action: connection.action || undefined,
    ...(connection.error_code ? { errorCode: connection.error_code } : {}),
    ...(connection.verified_at ? { verifiedAt: connection.verified_at } : {}),
    ...(connection.updated_at ? { updatedAt: connection.updated_at } : {})
  };
}

function forwardGatewayError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof LlmGatewayHttpError) {
    const mapped = mapGatewayError(err, {
      upstreamMessage: 'MCP connection service is unavailable'
    });
    if (mapped.status === 429 && err.retryAfter) {
      res.setHeader('Retry-After', err.retryAfter);
    }
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

async function requireConnectionServer(
  req: AuthenticatedRequest,
  res: Response,
  mutation = false
): Promise<ConnectionContext | null> {
  const workspaceId = toSingleParam(req.params.workspaceId);
  const serverId = toSingleParam(req.params.serverId);
  const targetId = toSingleParam(req.params.targetId);
  const agentId = toSingleParam(req.params.agentId);
  let authz: WorkspaceAuthorization;
  let servers: McpServerConfig[];
  if (agentId) {
    const workspaceAuthz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!workspaceAuthz) return null;
    authz = workspaceAuthz;
    servers = await listAgentMcpServers(workspaceId, agentId);
  } else if (targetId) {
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return null;
    authz = access.authz;
    servers = await listTargetMcpServers(
      workspaceId,
      access.target.id,
      access.target.targetType
    );
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
  if (server.credential_mode === 'none') {
    res.status(409).json({
      error: {
        code: 'MCP_CONNECTION_NOT_REQUIRED',
        message: 'This MCP installation does not use a credential connection.',
        retryable: false
      }
    });
    return null;
  }
  const workspaceManaged = server.credential_mode === 'workspace';
  const canManage = workspaceManaged ? authz.can('manage_mcp') : canRunWithMcp(authz);
  if (mutation && !canManage) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: workspaceManaged
          ? 'Managing the workspace MCP credential requires manage_mcp.'
          : 'Managing an individual MCP credential requires a run capability.',
        retryable: false
      }
    });
    return null;
  }
  return {
    workspaceId,
    server,
    authz,
    ownerType: workspaceManaged ? 'installation' : 'user',
    ownerId: workspaceManaged ? INSTALLATION_OWNER_ID : req.auth.userId,
    canManage
  };
}

export async function getMcpConnectionStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requireConnectionServer(req, res);
    if (!context) return;
    const connection = await getMcpConnection(
      context.workspaceId,
      context.server.id,
      context.ownerType,
      context.ownerId
    );
    res.status(200).json({ connection: mapConnection(connection, context.canManage) });
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}

function parseCredentialBody(req: AuthenticatedRequest, res: Response): string | null {
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
        code: 'MCP_CONNECTION_INVALID',
        message: 'Only credential and consentGranted are accepted.',
        retryable: false
      }
    });
    return null;
  }
  if (body.consentGranted !== true) {
    res.status(400).json({
      error: {
        code: 'MCP_CONNECTION_CONSENT_REQUIRED',
        message: 'Explicit consent is required before saving this credential.',
        retryable: false
      }
    });
    return null;
  }
  return credential;
}

async function auditConnection(
  req: AuthenticatedRequest,
  context: ConnectionContext,
  action: 'connected' | 'verified' | 'disconnected',
  status?: string
): Promise<void> {
  const mode = context.server.credential_mode;
  await recordWorkspaceAuditEvent({
    workspaceId: context.workspaceId,
    category: 'mcp',
    eventType: `mcp.${mode}_credential_${action}.v1`,
    operation: 'write',
    actorUserId: req.auth.userId,
    objectType: 'mcp_server',
    objectId: context.server.id,
    objectName: context.server.server_name,
    summary: `${mode === 'workspace' ? 'Workspace' : 'Individual'} MCP credential ${action}`,
    metadata: {
      credentialMode: mode,
      scopeType: context.server.scope_type,
      authType: context.server.auth_type,
      ...(status ? { status } : {})
    }
  });
}

export async function putMcpConnection(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requireConnectionServer(req, res, true);
    if (!context) return;
    const credential = parseCredentialBody(req, res);
    if (credential === null) return;
    const connection = await upsertMcpConnection({
      workspaceId: context.workspaceId,
      serverId: context.server.id,
      ownerType: context.ownerType,
      ownerId: context.ownerId,
      credential,
      consentGranted: true
    });
    await auditConnection(req, context, 'connected', connection.status);
    res.status(200).json({ connection: mapConnection(connection, context.canManage) });
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}

export async function verifyMcpConnectionStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requireConnectionServer(req, res, true);
    if (!context) return;
    const connection = await verifyMcpConnection(
      context.workspaceId,
      context.server.id,
      context.ownerType,
      context.ownerId
    );
    await auditConnection(req, context, 'verified', connection.status);
    res.status(200).json({ connection: mapConnection(connection, context.canManage) });
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}

export async function deleteMcpConnectionStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const context = await requireConnectionServer(req, res, true);
    if (!context) return;
    await deleteMcpConnection(
      context.workspaceId,
      context.server.id,
      context.ownerType,
      context.ownerId
    );
    await auditConnection(req, context, 'disconnected');
    res.status(204).end();
  } catch (err) {
    forwardGatewayError(err, res, next);
  }
}
