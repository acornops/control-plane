import { NextFunction, Response } from 'express';
import { z } from 'zod';
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

const targetTypeSchema = z.string().refine(isTargetType, 'Unsupported target type.').transform((value) => value as TargetType);
const catalogArtifactLocatorSchema = z.object({
  artifactId: z.string().trim().min(1).optional(),
  sourceId: z.string().trim().min(1).optional(),
  artifactName: z.string().trim().min(1).optional()
}).strict().refine(
  (value) => Boolean(value.artifactId || (value.sourceId && value.artifactName)),
  'An artifactId or sourceId plus artifactName is required.'
);
const catalogImportBaseBodySchema = z.object({
  artifact: catalogArtifactLocatorSchema,
  version: z.string().trim().min(1),
  remoteEndpoint: z.string().trim().min(1),
  serverName: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string()).optional(),
  endpointConfiguration: z.record(z.string()).optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  targetConstraints: z.object({
    targetTypes: z.array(targetTypeSchema).optional(),
    targetIds: z.array(z.string().trim().min(1)).optional()
  }).strict().optional()
}).strict();
const catalogReimportBodySchema = catalogImportBaseBodySchema.extend({
  expectedRevision: z.number().int().min(1)
}).strict();

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
    ['headerPrefix', previous.auth_header_prefix || null, current.auth_header_prefix || null],
    ['credentialMode', previous.credential_mode, current.credential_mode]
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
    eventType: 'mcp.connections_invalidated.v1',
    operation: 'write',
    actorUserId: input.req.auth.userId,
    objectType: 'mcp_server',
    objectId: input.server.id,
    objectName: input.server.server_name,
    summary: 'MCP connections invalidated after trust-boundary change',
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

export function parseCatalogImportBody(body: unknown, reimport = false): {
  artifact: { artifactId?: string; sourceId?: string; artifactName?: string };
  version: string;
  remoteEndpoint: string;
  serverName?: string;
  enabled?: boolean;
  publicHeaders?: Record<string, string>;
  endpointConfiguration?: Record<string, string>;
  credentialMode?: 'none' | 'workspace' | 'individual';
  targetConstraints?: { targetTypes: TargetType[]; targetIds: string[] };
  expectedRevision?: number;
} | null {
  const schema = reimport ? catalogReimportBodySchema : catalogImportBaseBodySchema;
  const result = schema.safeParse(body);
  if (!result.success) return null;
  const value = result.data;
  const publicHeaders = value.publicHeaders === undefined
    ? undefined
    : validateMcpPublicHeaders(value.publicHeaders);
  return {
    artifact: value.artifact,
    version: value.version,
    remoteEndpoint: value.remoteEndpoint,
    serverName: value.serverName,
    enabled: value.enabled ?? true,
    publicHeaders,
    endpointConfiguration: value.endpointConfiguration,
    credentialMode: value.credentialMode,
    targetConstraints: {
      targetTypes: [...new Set(value.targetConstraints?.targetTypes ?? [])],
      targetIds: [...new Set(value.targetConstraints?.targetIds ?? [])]
    },
    ...('expectedRevision' in value && typeof value.expectedRevision === 'number'
      ? { expectedRevision: value.expectedRevision }
      : {})
  };
}
