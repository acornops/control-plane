import type { AgentConnection } from './types.js';
import { closeStaleAgentConnection, getAgentConnectionForWebSocket } from './connections.js';
import { refreshAgentOwner } from '../services/control-plane-coordination.js';
import { repo } from '../store/repository.js';

export async function handleAgentHeartbeat(
  conn: AgentConnection | undefined,
  receivedAt: string,
  ensureCurrent: (conn: AgentConnection) => Promise<boolean>
): Promise<void> {
  if (!conn || getAgentConnectionForWebSocket(conn.ws) !== conn) return;
  if (!(await ensureCurrent(conn)) || getAgentConnectionForWebSocket(conn.ws) !== conn) return;
  const renewed = await refreshAgentOwner(conn.clusterId, conn.connectionId);
  if (getAgentConnectionForWebSocket(conn.ws) !== conn) return;
  if (!renewed) { closeStaleAgentConnection(conn.clusterId, conn); return; }
  await repo.updateTargetAgentSeen(conn.clusterId, {
    lastSeenAt: receivedAt, lastHeartbeatAt: receivedAt,
    expectedConnectionId: conn.connectionId, lastAuthenticatedKeyVersion: conn.keyVersion
  });
}
