import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import {
  requireClusterAccess,
  requireWorkspaceCapability
} from '../../auth/workspace-authorization.js';
import { LlmGatewayHttpError } from '../../services/mcp-registry-client.js';
import { cleanupKubernetesTargetMcpServers } from '../../services/target-mcp-cleanup.js';
import { webhooks } from '../../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { repo } from '../../store/repository.js';
import { KUBERNETES_TARGET_TYPE } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import { mapGatewayError } from './common.js';
import { disablePlatformTargetDiagnosticMappings } from '../../store/repository-capability-routing.js';

export async function deleteCluster(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return;
    }
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_targets',
        'Only workspace roles with target management capability can delete clusters'
      ))
    ) {
      return;
    }

    const cluster = access.cluster;
    await cleanupKubernetesTargetMcpServers(workspaceId, clusterId);
    const clusterDeletedWebhook = await webhooks.prepare({
      type: 'target.deleted.v1',
      workspaceId,
      clusterId,
      targetId: clusterId,
      targetType: KUBERNETES_TARGET_TYPE,
      subject: { type: 'target', id: clusterId },
      data: {
        targetType: KUBERNETES_TARGET_TYPE,
        name: cluster?.name || null,
        deletedBy: req.auth.userId
      }
    });

    const deleted = await repo.deleteCluster(clusterId);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Cluster not found', retryable: false } });
      return;
    }
    await disablePlatformTargetDiagnosticMappings(workspaceId, clusterId, []);

    webhooks.emitPrepared(clusterDeletedWebhook);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'target.deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'kubernetes_cluster',
      objectId: clusterId,
      objectName: cluster?.name || null,
      summary: 'Kubernetes cluster deleted',
      metadata: {}
    });
    res.status(204).send();
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
