import { config } from '../config.js';
import { logger } from '../logger.js';
import { claimAgentOwner, clearAgentOwnerIfCurrent, controlPlaneInstanceId, distributedRoutingEnabled, getAgentOwner, refreshAgentOwner } from '../services/control-plane-coordination.js';
import { webhooks } from '../services/webhooks.js';
import { vmConnections, type VirtualMachineConnectionTransition } from '../store/repository-vm-connections.js';
import { detachAgentConnection, getAgentConnection } from './connections.js';
import type { AgentConnection } from './types.js';
import { ownsVirtualMachineSocket, recordVirtualMachineSocketAttempt } from './vm-socket-ownership.js';

const attempts = new Map<string, string>();

function closeFailedSocket(conn: AgentConnection): void {
  if (ownsVirtualMachineSocket(conn)) conn.ws.close(1012, 'VM handshake did not complete');
}

// Only reads and identity-matched cleanup use this bound. Racing a claim SET
// would leave a mutating command capable of taking ownership after timeout.
async function boundedOwnerOperation<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('VM ownership observation timed out')), Math.min(5000, config.AGENT_WS_HANDSHAKE_TIMEOUT_MS));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function exactOwner(owner: Awaited<ReturnType<typeof getAgentOwner>>, conn: AgentConnection): boolean {
  return owner?.instanceId === controlPlaneInstanceId() && owner.connectionId === conn.connectionId;
}

function emitOffline(targetId: string, transition: VirtualMachineConnectionTransition): void {
  const scope = { workspaceId: transition.workspaceId, targetId, targetType: 'virtual_machine' as const };
  webhooks.emit({ type: 'agent.disconnected.v1', ...scope, subject: { type: 'agent', id: targetId },
    data: { connectionId: transition.connectionId, connectorVersion: transition.connectorVersion || null } });
  if (transition.previousStatus !== 'offline') webhooks.emit({ type: 'target.status_changed.v1', ...scope,
    subject: { type: 'target', id: targetId }, data: { targetType: 'virtual_machine', previousStatus: transition.previousStatus, status: 'offline', updatedAt: transition.updatedAt } });
}

/** Reconcile only the departing VM identity and retain intentional draining evidence. */
export async function disconnectVirtualMachine(conn: AgentConnection): Promise<void> {
  const targetId = conn.clusterId;
  const owner = await boundedOwnerOperation(getAgentOwner(targetId));
  const draining = exactOwner(owner, conn) && owner?.state === 'draining';
  if (draining) await boundedOwnerOperation(refreshAgentOwner(targetId, conn.connectionId, 'draining'));
  else await boundedOwnerOperation(clearAgentOwnerIfCurrent(targetId, conn.connectionId));
  const transition = await vmConnections.transition(targetId, {
    status: 'offline', connectionId: conn.connectionId,
    allow: async () => {
      const current = await boundedOwnerOperation(getAgentOwner(targetId));
      if (!distributedRoutingEnabled()) {
        const local = getAgentConnection(targetId);
        const attempt = attempts.get(targetId);
        return (!local || local.connectionId === conn.connectionId) && (!attempt || attempt === conn.connectionId);
      }
      return !current || (draining && exactOwner(current, conn) && current.state === 'draining');
    }
  });
  if (transition) emitOffline(targetId, transition);
}

async function cleanupFailedHandshake(conn: AgentConnection): Promise<void> {
  const targetId = conn.clusterId;
  detachAgentConnection(targetId, conn, 'VM handshake did not complete');
  closeFailedSocket(conn);
  // A late CAS clear can remove only this attempt, never its replacement.
  await boundedOwnerOperation(clearAgentOwnerIfCurrent(targetId, conn.connectionId));
  const transition = await vmConnections.transition(targetId, {
    status: 'offline',
    allow: async () => {
      if (await boundedOwnerOperation(getAgentOwner(targetId))) return false;
      if (distributedRoutingEnabled()) return true;
      return !getAgentConnection(targetId) && (!attempts.has(targetId) || attempts.get(targetId) === conn.connectionId);
    }
  });
  if (transition) emitOffline(targetId, transition);
}

/** Publish a VM connection only after its guarded database transition commits. */
export async function publishVirtualMachineConnection(input: {
  connection: AgentConnection;
  mayConnect: () => boolean;
  publish: (transition: VirtualMachineConnectionTransition) => void;
}): Promise<void> {
  const conn = input.connection; const targetId = conn.clusterId;
  if (!input.mayConnect()) { closeFailedSocket(conn); return; }
  attempts.set(targetId, conn.connectionId);
  recordVirtualMachineSocketAttempt(conn);
  const eligible = () => attempts.get(targetId) === conn.connectionId && ownsVirtualMachineSocket(conn) && input.mayConnect();
  const owns = async () => {
    const owner = await boundedOwnerOperation(getAgentOwner(targetId));
    return eligible() && (!distributedRoutingEnabled() || exactOwner(owner, conn));
  };
  let published = false;
  try {
    await claimAgentOwner({ clusterId: targetId, connectionId: conn.connectionId, workspaceId: conn.workspaceId, connectorVersion: conn.connectorVersion });
    if (!eligible()) return;
    const transition = await vmConnections.transition(targetId, { status: 'online', connectionId: conn.connectionId, connectorVersion: conn.connectorVersion, allow: owns });
    if (!transition || !(await owns()) || !eligible()) return;
    // No await between the final local fence and publication. A delayed older
    // transaction/read cannot install its socket over a newer local attempt.
    input.publish(transition); published = true;
  } finally {
    if (!published) {
      try { await cleanupFailedHandshake(conn); }
      catch (err) { logger.warn({ err, targetId }, 'VM handshake cleanup did not complete'); }
    }
    if (attempts.get(targetId) === conn.connectionId) attempts.delete(targetId);
  }
}
