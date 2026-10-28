import { getAgentOwner, clearAgentOwnerIfCurrent, controlPlaneInstanceId, refreshAgentOwner } from '../services/control-plane-coordination.js';
import { webhooks } from '../services/webhooks.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import { AgentConnection } from './types.js';

export async function markConnectionOfflineIfUnowned(clusterId: string, conn: AgentConnection): Promise<void> {
  const owner = await getAgentOwner(clusterId);
  const draining = owner?.state === 'draining' && owner.instanceId === controlPlaneInstanceId() && owner.connectionId === conn.connectionId;
  if (draining) {
    // Keep bounded evidence of an intentional reconnect for callers arriving in the gap.
    await refreshAgentOwner(clusterId, conn.connectionId, 'draining');
  }
  const cluster = await repo.getCluster(clusterId);
  if (!draining) await clearAgentOwnerIfCurrent(clusterId, conn.connectionId);
  const currentOwner = await getAgentOwner(clusterId);
  if (currentOwner && !(draining && currentOwner.state === 'draining'
    && currentOwner.instanceId === controlPlaneInstanceId() && currentOwner.connectionId === conn.connectionId)) {
    return;
  }

  await repo.updateTargetAgentSeen(clusterId, {
    lastSeenAt: new Date().toISOString(),
    lastConnectionId: undefined
  });
  const updated = await repo.updateCluster(clusterId, { status: 'offline' });
  webhooks.emit({
    type: 'agent.disconnected.v1',
    workspaceId: conn.workspaceId,
    clusterId,
    targetId: clusterId,
    targetType: KUBERNETES_TARGET_TYPE,
    subject: { type: 'agent', id: clusterId },
    data: {
      connectionId: conn.connectionId,
      connectorVersion: conn.connectorVersion || null
    }
  });
  if (cluster?.status !== 'offline') {
    webhooks.emit({
      type: 'target.status_changed.v1',
      workspaceId: conn.workspaceId,
      clusterId,
      targetId: clusterId,
      targetType: KUBERNETES_TARGET_TYPE,
      subject: { type: 'target', id: clusterId },
      data: {
        targetType: KUBERNETES_TARGET_TYPE,
        previousStatus: cluster?.status || null,
        status: 'offline',
        updatedAt: updated?.updatedAt || new Date().toISOString()
      }
    });
  }
}
