import { NextFunction, Response } from 'express';

import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability } from '../auth/workspace-authorization.js';
import {
  deleteCatalogSource,
  synchronizeCatalogSource,
  updateCatalogSource
} from '../services/mcp-catalog-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { toSingleParam } from '../utils/params.js';
import { badRequest, forwardCatalogError, mapSource } from './catalog-controller.js';

type SourceAuthPatch = {
  type: 'none' | 'bearer_token' | 'custom_header';
  credential?: string;
  headerName?: string;
};

function parseAuthPatch(value: unknown): SourceAuthPatch | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const auth = value as Record<string, unknown>;
  if (
    auth.type !== 'none'
    && auth.type !== 'bearer_token'
    && auth.type !== 'custom_header'
  ) return null;
  const credential = typeof auth.credential === 'string' && auth.credential.length > 0
    ? auth.credential
    : undefined;
  const headerName = typeof auth.headerName === 'string' && auth.headerName.trim()
    ? auth.headerName.trim()
    : undefined;
  if (auth.type !== 'none' && !credential) return null;
  if (auth.type === 'custom_header' && !headerName) return null;
  if (auth.type === 'none' && (credential || headerName)) return null;
  if (auth.type === 'bearer_token' && headerName) return null;
  return { type: auth.type, credential, headerName };
}

async function requireSourceManagement(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string
): Promise<boolean> {
  return Boolean(await requireWorkspaceCapability(
    req,
    res,
    workspaceId,
    'manage_catalog_sources',
    'No permission to manage MCP registries'
  ));
}

export async function updateWorkspaceCatalogSource(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const sourceId = toSingleParam(req.params.sourceId);
    if (!(await requireSourceManagement(req, res, workspaceId))) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    if (body.networkRoute !== undefined && body.networkRoute !== 'direct') {
      badRequest(res, 'Only direct MCP registry routing is currently available.');
      return;
    }
    const auth = parseAuthPatch(body.auth);
    if (auth === null) {
      badRequest(res, 'Authentication replacement is invalid or missing its credential.');
      return;
    }
    const source = await updateCatalogSource({
      workspaceId,
      sourceId,
      displayName: typeof body.displayName === 'string' ? body.displayName.trim() : undefined,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      networkRoute: body.networkRoute === 'direct' ? 'direct' : undefined,
      auth
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'mcp',
      eventType: 'workspace.catalog_source_updated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'catalog_source',
      objectId: source.id,
      objectName: source.display_name,
      summary: 'MCP registry updated',
      metadata: { sourceId: source.id, enabled: source.enabled }
    });
    if (typeof body.enabled === 'boolean') {
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'mcp',
        eventType: body.enabled
          ? 'workspace.catalog_source_enabled.v1'
          : 'workspace.catalog_source_disabled.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        objectType: 'catalog_source',
        objectId: source.id,
        objectName: source.display_name,
        summary: body.enabled ? 'MCP registry enabled' : 'MCP registry disabled',
        metadata: { sourceId: source.id }
      });
    }
    res.status(200).json({ source: mapSource(source) });
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}

export async function synchronizeWorkspaceCatalogSource(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const sourceId = toSingleParam(req.params.sourceId);
    if (!(await requireSourceManagement(req, res, workspaceId))) return;
    const result = await synchronizeCatalogSource(workspaceId, sourceId);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'mcp',
      eventType: 'workspace.catalog_source_synchronized.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'catalog_source',
      objectId: sourceId,
      summary: 'MCP registry synchronized',
      metadata: { sourceId, artifactCount: result.artifact_count }
    });
    res.status(200).json({ artifactCount: result.artifact_count });
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}

export async function deleteWorkspaceCatalogSource(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const sourceId = toSingleParam(req.params.sourceId);
    if (!(await requireSourceManagement(req, res, workspaceId))) return;
    await deleteCatalogSource(workspaceId, sourceId);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'mcp',
      eventType: 'workspace.catalog_source_deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'catalog_source',
      objectId: sourceId,
      summary: 'MCP registry deleted',
      metadata: { sourceId }
    });
    res.status(204).send();
  } catch (err) {
    forwardCatalogError(err, res, next);
  }
}
