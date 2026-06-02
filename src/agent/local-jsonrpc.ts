import { randomUUID } from 'node:crypto';
import { runtime } from '../store/runtime.js';
import { AgentConnection } from './types.js';

export async function sendLocalJsonRpc(
  conn: AgentConnection,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const requestId = `cmd_${randomUUID()}`;
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
    }, 15000);

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
