import { NextFunction, Response } from 'express';
import { z } from 'zod';

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

const sourceAuthPatchSchema = z.object({
  type: z.enum(['none', 'bearer_token', 'custom_header']),
  credential: z.string().min(1).optional(),
  headerName: z.string().trim().min(1).optional()
}).strict();

const updateCatalogSourceBodySchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  networkRoute: z.literal('direct').optional(),
  auth: sourceAuthPatchSchema.optional()
}).strict().refine((body) => Object.keys(body).length > 0, 'At least one catalog source field is required.');

function parseAuthPatch(value: unknown): SourceAuthPatch | undefined | null {
  if (value === undefined) return undefined;
  const parsed = sourceAuthPatchSchema.safeParse(value);
  if (!parsed.success) return null;
  const auth = parsed.data;
  const credential = auth.credential;
  const headerName = auth.headerName;
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
    const parsedBody = updateCatalogSourceBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      badRequest(res, parsedBody.error.issues[0]?.message || 'Catalog source update is invalid.');
      return;
    }
    const body = parsedBody.data;
    const auth = parseAuthPatch(body.auth);
    if (auth === null) {
      badRequest(res, 'Authentication replacement is invalid or missing its credential.');
      return;
    }
    const source = await updateCatalogSource({
      workspaceId,
      sourceId,
      displayName: body.displayName,
      baseUrl: body.baseUrl,
      enabled: body.enabled,
      networkRoute: body.networkRoute,
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
    if (body.enabled !== undefined) {
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
