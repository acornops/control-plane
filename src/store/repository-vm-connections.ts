import type { VirtualMachineTarget } from '../types/domain.js';
import { withTransaction } from './repository-transaction.js';

export interface VirtualMachineConnectionTransition {
  workspaceId: string;
  previousStatus: VirtualMachineTarget['status'];
  status: 'online' | 'offline';
  updatedAt: string;
  connectionId: string;
  connectorVersion?: string;
}

/** Serialize VM status and identity without replacing independently edited metadata. */
export async function transitionVirtualMachineConnection(
  targetId: string,
  input: {
    status: 'online' | 'offline';
    connectionId?: string;
    connectorVersion?: string;
    heartbeatAt?: string;
    allow: () => Promise<boolean>;
  }
): Promise<VirtualMachineConnectionTransition | null> {
  return withTransaction(async (client) => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const target = await client.query<{ workspace_id: string; status: VirtualMachineTarget['status'] }>(
      "SELECT workspace_id,status FROM targets WHERE id=$1 AND target_type='virtual_machine' FOR UPDATE", [targetId]
    );
    if (!target.rowCount) return null;
    const registration = await client.query<{ last_connection_id: string | null; last_connector_version: string | null }>(
      'SELECT last_connection_id,last_connector_version FROM target_agent_registrations WHERE target_id=$1 FOR UPDATE', [targetId]
    );
    if (!registration.rowCount) return null;
    const current = registration.rows[0];
    if (input.status === 'offline' && (!current.last_connection_id
      || (input.connectionId !== undefined && current.last_connection_id !== input.connectionId))) return null;
    if (input.status === 'online' && !input.connectionId) throw new Error('VM online transition requires a connection identity');
    if (!(await input.allow())) return null;
    const updatedAt = new Date().toISOString();
    await client.query('UPDATE targets SET status=$2,updated_at=$3 WHERE id=$1', [targetId, input.status, updatedAt]);
    await client.query(`UPDATE target_agent_registrations SET last_connection_id=$2,last_seen_at=$3,
      last_connector_version=COALESCE($4,last_connector_version),last_heartbeat_at=COALESCE($5,last_heartbeat_at) WHERE target_id=$1`,
      [targetId, input.status === 'online' ? input.connectionId : null, updatedAt, input.status === 'online' ? input.connectorVersion : null,
        input.status === 'online' ? input.heartbeatAt ?? updatedAt : null]);
    return {
      workspaceId: target.rows[0].workspace_id, previousStatus: target.rows[0].status,
      status: input.status, updatedAt, connectionId: input.status === 'online' ? input.connectionId! : current.last_connection_id!,
      connectorVersion: input.status === 'online' ? input.connectorVersion : current.last_connector_version || undefined
    };
  });
}

export const vmConnections = { transition: transitionVirtualMachineConnection };
