import { NextFunction, Response } from 'express';
import { agentGateway } from '../../agent/ws-server.js';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireClusterAccess, requireWorkspaceCapability } from '../../auth/workspace-authorization.js';
import { webhooks } from '../../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { repo } from '../../store/repository.js';
import { KUBERNETES_TARGET_TYPE } from '../../types/domain.js';
import { generateAgentKey, hashSecret } from '../../utils/crypto.js';
import { toSingleParam } from '../../utils/params.js';
import { buildAgentInstallInstructions, parseAgentAccessMode } from './kubernetes-cluster-request-utils.js';

/** Rotate an AgentK key while preserving the cluster's immutable RBAC snapshot. */
export async function rotateAgentKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const agentAccessMode = parseAgentAccessMode(req.body?.agentAccessMode);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) return;
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_agent_keys',
      'Only workspace roles with agent-key management capability can rotate agent keys'
    ))) return;

    const reg = await repo.getTargetAgentRegistration(clusterId);
    if (!reg) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent registration not found', retryable: false } });
      return;
    }
    const rbacSnapshot = await repo.getClusterRbacAdditionsSnapshot(clusterId);
    const rawAgentKey = generateAgentKey(clusterId);
    const keyVersion = await repo.rotateTargetAgentKey(clusterId, reg.keyVersion, hashSecret(rawAgentKey));
    if (keyVersion === null) {
      res.status(409).json({
        error: {
          code: 'AGENT_KEY_ROTATION_CONFLICT',
          message: 'Agent key changed during rotation; generate a new install command and retry',
          retryable: true
        }
      });
      return;
    }
    await agentGateway.disconnectCluster(clusterId, 'Agent key rotated');
    webhooks.emit({
      type: 'agent.key_rotated.v1',
      workspaceId,
      clusterId,
      targetId: clusterId,
      targetType: KUBERNETES_TARGET_TYPE,
      subject: { type: 'agent', id: clusterId },
      data: { keyVersion, rotatedBy: req.auth.userId }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'agent.key_rotated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'kubernetes_cluster',
      objectId: clusterId,
      objectName: access.cluster.name,
      summary: 'Cluster agent key rotated',
      metadata: { keyVersion, agentAccessMode }
    });
    res.status(200).json({
      clusterId,
      agentKey: rawAgentKey,
      keyVersion,
      installInstructions: buildAgentInstallInstructions(
        access.cluster,
        rawAgentKey,
        agentAccessMode,
        rbacSnapshot?.additions || []
      )
    });
  } catch (err) {
    next(err);
  }
}
