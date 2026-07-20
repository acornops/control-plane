import { DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_VM_ID, DEVELOPMENT_WORKSPACE_ID } from '../constants/dev-defaults.js';
import { db } from '../infra/db.js';
import { provisionWorkspaceWithStarterAutomation } from '../services/workspace-provisioning.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { hashSecret } from '../utils/crypto.js';
import { upsertTargetAgentRegistration } from './repository-target-agent-registrations.js';
import { upsertUser } from './repository-users.js';

const DEVELOPMENT_USER_EMAIL = 'dev@acornops.local';
const DEVELOPMENT_USER_DISPLAY_NAME = 'Dev User';

export async function ensureDevelopmentWorkspaceAndTargets(
  createdByUserId: string,
  seedAgentKey?: string,
  seedVmAgentKey?: string
): Promise<void> {
  await provisionWorkspaceWithStarterAutomation({
    id: DEVELOPMENT_WORKSPACE_ID,
    name: 'Development Workspace',
    createdBy: createdByUserId,
    membershipSource: 'oidc',
    idempotent: true,
    enforceQuotas: false
  });

  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
     VALUES ($1, $2, 'kubernetes', $3, 'offline', '{}'::jsonb, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_WORKSPACE_ID, 'Development Cluster', now, now]
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
     VALUES ($1, $2, $3, $4, 'offline', $5::jsonb, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      DEVELOPMENT_VM_ID,
      DEVELOPMENT_WORKSPACE_ID,
      VIRTUAL_MACHINE_TARGET_TYPE,
      'Development Linux VM',
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

export async function ensureDevelopmentTargetSeed(seedAgentKey?: string, seedVmAgentKey?: string): Promise<void> {
  const user = await upsertUser(DEVELOPMENT_USER_EMAIL, DEVELOPMENT_USER_DISPLAY_NAME);
  await ensureDevelopmentWorkspaceAndTargets(user.id, seedAgentKey, seedVmAgentKey);
}
