import { beginAgentDispatch } from './owner-handoff.js';
import { assertAgentExecutionAllowed } from './execution-authority.js';
import { currentRequestSignal } from '../services/service-lifecycle.js';
import WebSocket from 'ws';
import { getAgentConnection } from './connections.js';
import { assertActiveWorkspace } from '../services/workspace-execution-access.js';
import { randomUUID } from 'node:crypto';
import { runtime } from '../store/runtime.js';
import { AgentConnection } from './types.js';

export class OwnerDrainingError extends Error {}
export class AgentConnectionChangedBeforeDispatchError extends Error {}
const activeCommands = new Map<string, number>();

export function hasActiveLocalCommands(connectionId: string): boolean {
  return (activeCommands.get(connectionId) || 0) > 0;
}

export const AGENT_COMMAND_TIMEOUT_MS = 25_000;

async function dispatchLocalJsonRpc(
  conn: AgentConnection,
  method: string,
  params: Record<string, unknown>,
  stableRequestId?: string,
  mayDispatch: () => boolean = () => true
): Promise<unknown> {
  if (stableRequestId && (stableRequestId.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(stableRequestId))) {
    throw new Error('Invalid stable agent request ID');
  }
  if (method === 'tools/call') await assertActiveWorkspace(conn.workspaceId);
  await assertAgentExecutionAllowed();
  if (currentRequestSignal()?.aborted) throw new Error('Caller cancelled before agent dispatch');
  if (!mayDispatch()) throw new OwnerDrainingError('Agent owner is draining');
  if (conn.ws.readyState !== WebSocket.OPEN || getAgentConnection(conn.clusterId)?.connectionId !== conn.connectionId) {
    throw new AgentConnectionChangedBeforeDispatchError('Agent connection changed before dispatch');
  }
  const requestId = stableRequestId || `cmd_${randomUUID()}`;
  if (runtime.agentCommands.has(requestId)) {
    throw new Error('Agent command with this operation ID is already in progress');
  }
  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params
  };

  beginAgentDispatch();
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      runtime.agentCommands.delete(requestId);
      reject(new Error('Agent command timed out'));
    }, AGENT_COMMAND_TIMEOUT_MS);

    runtime.agentCommands.set(requestId, {
      id: requestId,
      createdAt: Date.now(),
      clusterId: conn.clusterId,
      connectionId: conn.connectionId,
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    });

    conn.ws.send(JSON.stringify(payload), (err) => {
      if (err) {
        runtime.agentCommands.delete(requestId);
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

export async function sendLocalJsonRpc(
  conn: AgentConnection, method: string, params: Record<string, unknown>, stableRequestId?: string,
  mayDispatch: () => boolean = () => true
): Promise<unknown> {
  activeCommands.set(conn.connectionId, (activeCommands.get(conn.connectionId) || 0) + 1);
  try { return await dispatchLocalJsonRpc(conn, method, params, stableRequestId, mayDispatch); }
  finally {
    const remaining = (activeCommands.get(conn.connectionId) || 1) - 1;
    if (remaining) activeCommands.set(conn.connectionId, remaining);
    else activeCommands.delete(conn.connectionId);
  }
}
