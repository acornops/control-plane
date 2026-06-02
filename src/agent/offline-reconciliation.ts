import { getAgentOwner, clearAgentOwnerIfCurrent } from '../services/control-plane-coordination.js';
import { webhooks } from '../services/webhooks.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import { AgentConnection } from './types.js';

export async function markConnectionOfflineIfUnowned(clusterId: string, conn: AgentConnection): Promise<void> {
  const cluster = await repo.getCluster(clusterId);
  await clearAgentOwnerIfCurrent(clusterId, conn.connectionId);
  const currentOwner = await getAgentOwner(clusterId);
  if (currentOwner) {
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
      agentVersion: conn.agentVersion || null
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
