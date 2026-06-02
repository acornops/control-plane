import WebSocket from 'ws';
import { logger } from '../logger.js';
import { runtime } from '../store/runtime.js';
import { AgentConnection } from './types.js';

const connections = new Map<string, AgentConnection>(); // Kubernetes target id -> conn

export function getAgentConnection(clusterId: string): AgentConnection | undefined {
  return connections.get(clusterId);
}

export function getAgentConnectionForWebSocket(ws: WebSocket): AgentConnection | undefined {
  return [...connections.values()].find((conn) => conn.ws === ws);
}

export function listAgentConnections(): Array<[string, AgentConnection]> {
  return [...connections.entries()];
}

export function setAgentConnection(clusterId: string, conn: AgentConnection): void {
  connections.set(clusterId, conn);
}

export function rejectPendingCommandsForConnection(clusterId: string, connectionId: string, reason: string): void {
  for (const [requestId, pending] of runtime.agentCommands.entries()) {
    if (pending.clusterId !== clusterId || pending.connectionId !== connectionId) continue;
    runtime.agentCommands.delete(requestId);
    pending.reject(new Error(reason));
  }
}

export function detachAgentConnection(clusterId: string, conn: AgentConnection, reason: string): void {
  const current = connections.get(clusterId);
  if (current?.connectionId === conn.connectionId) {
    connections.delete(clusterId);
  }
  if (conn.ownerRefreshInterval) {
    clearInterval(conn.ownerRefreshInterval);
    delete conn.ownerRefreshInterval;
  }
  rejectPendingCommandsForConnection(clusterId, conn.connectionId, reason);
}

export function closeStaleAgentConnection(clusterId: string, conn: AgentConnection): void {
  detachAgentConnection(clusterId, conn, 'Agent connection closed');
  if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
    conn.ws.close(1012, 'Agent ownership moved to another control-plane instance');
  }
}

export function resolvePendingAgentResponse(ws: WebSocket, payload: { id: string | number; error?: { message?: unknown }; result?: unknown }): boolean {
  const requestId = String(payload.id);
  const pending = runtime.agentCommands.get(requestId);
  if (!pending) return true;
  const conn = getAgentConnectionForWebSocket(ws);
  if (!conn || conn.clusterId !== pending.clusterId || conn.connectionId !== pending.connectionId) {
    logger.warn(
      { requestId, clusterId: pending.clusterId },
      'Ignoring agent JSON-RPC response from non-owning connection'
    );
    return true;
  }

  runtime.agentCommands.delete(requestId);
  if (payload.error) {
    pending.reject(new Error(String(payload.error.message || 'Unknown agent error')));
  } else if ('result' in payload) {
    pending.resolve(payload.result);
  } else {
    pending.resolve(undefined);
  }
  return true;
}

export function resetAgentConnectionsForTests(): void {
  for (const [clusterId, conn] of connections.entries()) {
    if (conn.ownerRefreshInterval) {
      clearInterval(conn.ownerRefreshInterval);
    }
    rejectPendingCommandsForConnection(clusterId, conn.connectionId, 'Agent gateway test reset');
  }
  connections.clear();
}
