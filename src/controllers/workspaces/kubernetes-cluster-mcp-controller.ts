import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireClusterAccess } from '../../auth/workspace-authorization.js';
import { composeKubernetesClusterToolsCatalog } from '../../services/kubernetes-cluster-tools-catalog.js';
import { pageInMemory } from '../../services/snapshot-listing.js';
import {
  deleteTargetMcpServer,
  LlmGatewayHttpError,
  listTargetMcpServers,
  listTargetMcpTools
} from '../../services/mcp-registry-client.js';
import { repo } from '../../store/repository.js';
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
import { KUBERNETES_TARGET_TYPE } from '../../types/domain.js';

export async function cleanupTargetMcpServers(workspaceId: string, targetId: string): Promise<void> {
  const servers = await listTargetMcpServers(workspaceId, targetId, KUBERNETES_TARGET_TYPE);
  for (const server of servers) {
    await deleteTargetMcpServer(workspaceId, targetId, KUBERNETES_TARGET_TYPE, server.id);
  }
}

export async function listKubernetesClusterToolsCatalog(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return;
    }

    const [tools, servers, overrides] = await Promise.all([
      listTargetMcpTools(workspaceId, clusterId, KUBERNETES_TARGET_TYPE, {
        includeServerDisabled: true,
        includeDisabled: true
      }),
      listTargetMcpServers(workspaceId, clusterId, KUBERNETES_TARGET_TYPE),
      repo.listTargetToolOverrides(clusterId)
    ]);
    const catalog = composeKubernetesClusterToolsCatalog({
      workspaceId,
      clusterId,
      canEdit: access.authz.can('manage_tools') && access.authz.can('manage_mcp'),
      tools,
      servers,
      overrides
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
