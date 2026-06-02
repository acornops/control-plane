import { db } from '../infra/db.js';
import { TargetAgentRegistration } from '../types/domain.js';
import { mapTargetAgentRegistration } from './repository-mappers.js';

export async function upsertTargetAgentRegistration(reg: TargetAgentRegistration): Promise<void> {
  await db.query(
    `INSERT INTO target_agent_registrations (
       target_id, workspace_id, agent_key_hash, key_version, last_seen_at, last_heartbeat_at,
       last_connection_id, last_agent_version, capabilities
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (target_id) DO UPDATE
     SET workspace_id = EXCLUDED.workspace_id,
         agent_key_hash = EXCLUDED.agent_key_hash,
         key_version = EXCLUDED.key_version,
         last_seen_at = EXCLUDED.last_seen_at,
         last_heartbeat_at = EXCLUDED.last_heartbeat_at,
         last_connection_id = EXCLUDED.last_connection_id,
         last_agent_version = EXCLUDED.last_agent_version,
         capabilities = EXCLUDED.capabilities`,
    [
      reg.targetId,
      reg.workspaceId,
      reg.agentKeyHash,
      reg.keyVersion,
      reg.lastSeenAt || null,
      reg.lastHeartbeatAt || null,
      reg.lastConnectionId || null,
      reg.lastAgentVersion || null,
      JSON.stringify(reg.capabilities || null)
    ]
  );
}

export async function getTargetAgentRegistration(targetId: string): Promise<TargetAgentRegistration | null> {
  const result = await db.query(
    `SELECT r.*, t.target_type
     FROM target_agent_registrations r
     INNER JOIN targets t ON t.id = r.target_id
     WHERE r.target_id = $1`,
    [targetId]
  );
  if (!result.rowCount) return null;
  return mapTargetAgentRegistration(result.rows[0]);
}

export async function listTargetAgentRegistrations(): Promise<TargetAgentRegistration[]> {
  const result = await db.query(
    `SELECT r.*, t.target_type
     FROM target_agent_registrations r
     INNER JOIN targets t ON t.id = r.target_id`
  );
  return result.rows.map(mapTargetAgentRegistration);
}

export async function updateTargetAgentSeen(
  targetId: string,
  data: { lastSeenAt?: string; lastHeartbeatAt?: string; lastConnectionId?: string; lastAgentVersion?: string }
): Promise<void> {
  const reg = await getTargetAgentRegistration(targetId);
  if (!reg) return;
  await upsertTargetAgentRegistration({
    ...reg,
    lastSeenAt: data.lastSeenAt ?? reg.lastSeenAt,
    lastHeartbeatAt: data.lastHeartbeatAt ?? reg.lastHeartbeatAt,
    lastConnectionId: data.lastConnectionId ?? reg.lastConnectionId,
    lastAgentVersion: data.lastAgentVersion ?? reg.lastAgentVersion
  });
}
