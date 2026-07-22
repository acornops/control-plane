import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import {
  LlmGatewayHttpError,
  listTargetMcpServers as listGatewayTargetMcpServers,
  toPublicMcpServerConfig
} from '../../services/mcp-registry-client.js';
import { toSingleParam } from '../../utils/params.js';
import { mapGatewayError } from './common.js';

export async function listTargetMcpServers(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const servers = await listGatewayTargetMcpServers(workspaceId, targetId, access.target.targetType);
    res.status(200).json(servers.map(toPublicMcpServerConfig));
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
