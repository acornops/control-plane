import { serviceLifecycle } from '../services/service-lifecycle.js';
import { distributedRoutingEnabled, refreshAgentOwner } from '../services/control-plane-coordination.js';
import { hasActiveLocalCommands } from './local-jsonrpc.js';
import type { AgentConnection } from './types.js';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../logger.js';
import { detachAgentConnection, getAgentConnectionForWebSocket, listAgentConnections } from './connections.js';
import { markConnectionOfflineIfUnowned } from './offline-reconciliation.js';

export async function shutdownAgentGateway(wss: WebSocketServer, graceMs = 5000): Promise<void> {
  const activeConnections = listAgentConnections();
  for (const ws of wss.clients) {
    if (!getAgentConnectionForWebSocket(ws)) ws.terminate();
  }

  await Promise.all(activeConnections.map(async ([clusterId, conn]) => {
    detachAgentConnection(clusterId, conn, 'Agent connection closed');
    await new Promise<void>((resolve) => {
      if (conn.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        if (conn.ws.readyState !== WebSocket.CLOSED) {
          conn.ws.terminate();
        }
        resolve();
      }, graceMs);
      timeout.unref();
      conn.ws.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
        conn.ws.close(1001, 'Control plane shutting down');
      } else {
        resolve();
      }
    });
    await markConnectionOfflineIfUnowned(clusterId, conn).catch((err) => {
      logger.warn({ err, clusterId }, 'Failed updating cluster offline status during shutdown');
    });
  }));

  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
}


export async function drainAgentConnections(
  wss: WebSocketServer, closeConnection: (targetId: string, conn: AgentConnection) => Promise<void>
): Promise<void> {
  const connections = listAgentConnections();
  for (const ws of wss.clients) {
    if (!getAgentConnectionForWebSocket(ws)) ws.close(1012, 'Control plane draining');
  }
  await Promise.all(connections.map(([targetId, conn]) => refreshAgentOwner(targetId, conn.connectionId, 'draining')));
  for (const [targetId, conn] of distributedRoutingEnabled() ? connections : []) {
    void serviceLifecycle.track(async () => {
      while (hasActiveLocalCommands(conn.connectionId) && !serviceLifecycle.isStopping) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await closeConnection(targetId, conn);
    }).catch((err) => logger.warn({ err, targetId }, 'Agent drain handoff failed'));
  }
}
