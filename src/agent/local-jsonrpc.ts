import { randomUUID } from 'node:crypto';
import { runtime } from '../store/runtime.js';
import { AgentConnection } from './types.js';

export const AGENT_COMMAND_TIMEOUT_MS = 25_000;

export async function sendLocalJsonRpc(
  conn: AgentConnection,
  method: string,
  params: Record<string, unknown>,
  stableRequestId?: string
): Promise<unknown> {
  if (stableRequestId && (stableRequestId.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(stableRequestId))) {
    throw new Error('Invalid stable agent request ID');
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
