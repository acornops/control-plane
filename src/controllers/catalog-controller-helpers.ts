import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import {
  CatalogArtifactConfig,
  CatalogSourceConfig,
  LlmGatewayHttpError,
  type McpServerConfig
} from '../services/mcp-registry-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  InvalidMcpPublicHeadersError,
  validateMcpPublicHeaders
} from '../services/mcp-public-header-policy.js';
import { isTargetType, type TargetType } from '../types/domain.js';
import { mapGatewayError } from './workspaces/common.js';

export function forwardCatalogError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof InvalidMcpPublicHeadersError) {
    res.status(400).json({
      error: { code: err.code, message: err.message, retryable: false }
    });
    return;
  }
  if (err instanceof LlmGatewayHttpError) {
    const mapped = mapGatewayError(err, { upstreamMessage: 'Catalog service is unavailable' });
    res.status(mapped.status).json(mapped.body);
    return;
  }
  next(err);
}

export function badRequest(res: Response, message: string): void {
  res.status(400).json({
    error: { code: 'CATALOG_REQUEST_INVALID', message, retryable: false }
  });
}

export function trustBoundaryChanges(
  previous: McpServerConfig | undefined,
  current: McpServerConfig
): string[] {
  if (!previous) return [];
  const fields: Array<[string, unknown, unknown]> = [
    ['effectiveUrl', previous.server_url, current.server_url],
    ['authType', previous.auth_type, current.auth_type],
    ['headerName', previous.auth_header_name || null, current.auth_header_name || null],
    ['headerPrefix', previous.auth_header_prefix || null, current.auth_header_prefix || null]
  ];
  return fields.filter(([, before, after]) => before !== after).map(([name]) => name);
}

export async function auditTrustBoundaryInvalidation(input: {
  req: AuthenticatedRequest;
  workspaceId: string;
  server: McpServerConfig;
  changedFields: string[];
  agentId?: string;
  targetId?: string;
  targetType?: TargetType;
}): Promise<void> {
  if (input.changedFields.length === 0) return;
  await recordWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'mcp',
    eventType: 'mcp.personal_connections_invalidated.v1',
    operation: 'write',
    actorUserId: input.req.auth.userId,
    objectType: 'mcp_server',
    objectId: input.server.id,
    objectName: input.server.server_name,
    summary: 'Personal MCP connections invalidated after trust-boundary change',
    metadata: {
      agentId: input.agentId,
      targetId: input.targetId,
      targetType: input.targetType,
      changedFields: input.changedFields
    }
  });
}

export function mapSource(source: CatalogSourceConfig) {
  return {
    id: source.id,
    workspaceId: source.workspace_id,
    displayName: source.display_name,
    baseUrl: source.base_url,
    authType: source.auth_type,
    credentialConfigured: source.credential_configured,
    authHeaderName: source.auth_header_name || undefined,
    networkRoute: source.network_route,
    enabled: source.enabled,
    managementMode: source.management_mode,
    bindings: source.bindings.map((binding) => ({
      id: binding.id,
      artifactKind: binding.artifact_kind,
      adapterType: binding.adapter_type,
      adapterBasePath: binding.adapter_base_path,
      syncStatus: binding.sync_status,
      lastSyncAt: binding.last_sync_at || undefined,
      lastSyncError: binding.last_sync_error || undefined
    })),
    createdAt: source.created_at || undefined,
    updatedAt: source.updated_at || undefined
  };
}

export function mapArtifact(artifact: CatalogArtifactConfig) {
  return {
    id: artifact.id,
    workspaceId: artifact.workspace_id,
    sourceId: artifact.source_id,
    bindingId: artifact.binding_id,
    artifactKind: artifact.artifact_kind,
    name: artifact.name,
    title: artifact.title || undefined,
    description: artifact.description,
    version: artifact.version,
    digest: artifact.digest,
    metadata: artifact.metadata,
    compatible: artifact.compatible,
    incompatibilityReason: artifact.incompatibility_reason || undefined,
    remoteEndpoints: artifact.remote_endpoints,
    publishedAt: artifact.published_at || undefined,
    upstreamUpdatedAt: artifact.upstream_updated_at || undefined
  };
}

export function parseCatalogImportBody(body: unknown): {
  artifact: { artifactId?: string; sourceId?: string; artifactName?: string };
  version: string;
  remoteEndpoint: string;
  serverName?: string;
  enabled?: boolean;
  publicHeaders?: Record<string, string>;
  endpointConfiguration?: Record<string, string>;
  targetConstraints?: { targetTypes: TargetType[]; targetIds: string[] };
} | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const artifactValue = value.artifact;
  if (!artifactValue || typeof artifactValue !== 'object' || Array.isArray(artifactValue)) return null;
  const locator = artifactValue as Record<string, unknown>;
  const artifact = {
    artifactId: typeof locator.artifactId === 'string' ? locator.artifactId : undefined,
    sourceId: typeof locator.sourceId === 'string' ? locator.sourceId : undefined,
    artifactName: typeof locator.artifactName === 'string' ? locator.artifactName : undefined
  };
  if (!artifact.artifactId && !(artifact.sourceId && artifact.artifactName)) return null;
  if (typeof value.version !== 'string' || !value.version.trim()) return null;
  if (typeof value.remoteEndpoint !== 'string' || !value.remoteEndpoint.trim()) return null;
  const publicHeaders = value.publicHeaders === undefined
    ? undefined
    : value.publicHeaders && typeof value.publicHeaders === 'object' && !Array.isArray(value.publicHeaders)
      ? validateMcpPublicHeaders(value.publicHeaders as Record<string, unknown>)
      : (() => { throw new InvalidMcpPublicHeadersError('publicHeaders must be an object'); })();
  const endpointConfiguration = value.endpointConfiguration
    && typeof value.endpointConfiguration === 'object'
    && !Array.isArray(value.endpointConfiguration)
    ? value.endpointConfiguration as Record<string, string>
    : undefined;
  const targetConstraintsValue = value.targetConstraints && typeof value.targetConstraints === 'object' && !Array.isArray(value.targetConstraints)
    ? value.targetConstraints as Record<string, unknown>
    : {};
  const targetTypes = Array.isArray(targetConstraintsValue.targetTypes)
    ? targetConstraintsValue.targetTypes.filter((item): item is TargetType => typeof item === 'string' && isTargetType(item))
    : [];
  const targetIds = Array.isArray(targetConstraintsValue.targetIds)
    ? targetConstraintsValue.targetIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
  return {
    artifact,
    version: value.version.trim(),
    remoteEndpoint: value.remoteEndpoint.trim(),
    serverName: typeof value.serverName === 'string' && value.serverName.trim() ? value.serverName.trim() : undefined,
    enabled: value.enabled !== false,
    publicHeaders,
    endpointConfiguration,
    targetConstraints: { targetTypes: [...new Set(targetTypes)], targetIds: [...new Set(targetIds)] }
  };
}
