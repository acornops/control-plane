import { DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_VM_ID, DEVELOPMENT_WORKSPACE_ID } from '../constants/dev-defaults.js';
import { db } from '../infra/db.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { hashSecret } from '../utils/crypto.js';
import { upsertTargetAgentRegistration } from './repository-target-agent-registrations.js';

export async function ensureDevelopmentWorkspaceAndTargets(
  createdByUserId: string,
  seedAgentKey?: string,
  seedVmAgentKey?: string
): Promise<void> {
  await db.query(
    `INSERT INTO workspaces (id, name, created_by, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [DEVELOPMENT_WORKSPACE_ID, 'Development Workspace', createdByUserId]
  );

  await db.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [DEVELOPMENT_WORKSPACE_ID, createdByUserId, 'owner', 'oidc']
  );

  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
     VALUES ($1, $2, 'kubernetes', $3, $4, '{}'::jsonb, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_WORKSPACE_ID, 'Development Cluster', 'offline', now, now]
  );
  await db.query(
    `INSERT INTO kubernetes_target_settings (target_id, namespace_include, namespace_exclude)
     VALUES ($1, '[]'::jsonb, '[]'::jsonb)
     ON CONFLICT (target_id) DO NOTHING`,
    [DEVELOPMENT_CLUSTER_ID]
  );

  if (seedAgentKey) {
    await upsertTargetAgentRegistration({
      targetId: DEVELOPMENT_CLUSTER_ID,
      targetType: KUBERNETES_TARGET_TYPE,
      workspaceId: DEVELOPMENT_WORKSPACE_ID,
      agentKeyHash: hashSecret(seedAgentKey),
      keyVersion: 1
    });
  }

  await db.query(
    `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      DEVELOPMENT_VM_ID,
      DEVELOPMENT_WORKSPACE_ID,
      VIRTUAL_MACHINE_TARGET_TYPE,
      'Development Linux VM',
      'offline',
      JSON.stringify({
        hostname: 'acornops-dev-vm',
        osFamily: 'linux',
        serviceManager: 'systemd',
        environment: 'local',
        capabilities: ['read', 'logs', 'mcp', 'chat', 'systemd', 'linux']
      }),
      now,
      now
    ]
  );

  if (seedVmAgentKey) {
    await upsertTargetAgentRegistration({
      targetId: DEVELOPMENT_VM_ID,
      targetType: VIRTUAL_MACHINE_TARGET_TYPE,
      workspaceId: DEVELOPMENT_WORKSPACE_ID,
      agentKeyHash: hashSecret(seedVmAgentKey),
      keyVersion: 1
    });
  }
}
