import { NextFunction, Response } from 'express';
import { agentGateway } from '../../agent/ws-server.js';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import { composeTargetToolsCatalog } from '../../services/kubernetes-cluster-tools-catalog.js';
import {
  LlmGatewayHttpError,
  listTargetMcpServers as listGatewayTargetMcpServers,
  listTargetMcpTools
} from '../../services/mcp-registry-client.js';
import { pageInMemory } from '../../services/snapshot-listing.js';
import { resolveMcpServerDefaults } from '../../services/workspace-default-resolution.js';
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

export async function listTargetMcpCatalog(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const [tools, localServers, overrides, agentRegistration, targetAgentConnected] = await Promise.all([
      listTargetMcpTools(workspaceId, targetId, access.target.targetType, {
        includeServerDisabled: true,
        includeDisabled: true
      }),
      listGatewayTargetMcpServers(workspaceId, targetId, access.target.targetType),
      repo.listTargetToolOverrides(targetId),
      repo.getTargetAgentRegistration(targetId),
      agentGateway.isAgentConnected(targetId)
    ]);
    const servers = await resolveMcpServerDefaults(localServers, access.target.targetType, {
      workspaceId,
      destinationId: targetId
    });
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
