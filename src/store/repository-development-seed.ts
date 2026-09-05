import { DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_VM_ID, DEVELOPMENT_WORKSPACE_ID } from '../constants/dev-defaults.js';
import { db } from '../infra/db.js';
import { provisionWorkspaceWithStarterAutomation } from '../services/workspace-provisioning.js';
import { READ_ONLY_AGENTV_ACCESS_POLICY } from '../types/agentv-access-policy.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { hashSecret } from '../utils/crypto.js';
import { upsertTargetAgentRegistration } from './repository-target-agent-registrations.js';
import { upsertUser } from './repository-users.js';

const DEVELOPMENT_USER_EMAIL = 'dev@acornops.local';
const DEVELOPMENT_USER_DISPLAY_NAME = 'Dev User';
const DEVELOPMENT_VM_ENROLLMENT_ID = `development-seed-${DEVELOPMENT_VM_ID}`;
const DEVELOPMENT_VM_CREDENTIAL_ID = `development-seed-credential-${DEVELOPMENT_VM_ID}`;

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
    const keyHash = hashSecret(seedVmAgentKey);
    await db.query(
      `INSERT INTO agentv_enrollments
         (id, target_id, workspace_id, purpose, access_policy, token_hash, status, created_by,
          expires_at, completed_at, updated_at)
       VALUES ($1, $2, $3, 'initial', $4::jsonb, $5, 'completed', $6, NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE
       SET target_id = EXCLUDED.target_id,
           workspace_id = EXCLUDED.workspace_id,
           access_policy = EXCLUDED.access_policy,
           token_hash = EXCLUDED.token_hash,
           status = 'completed',
           completed_at = COALESCE(agentv_enrollments.completed_at, NOW()),
           updated_at = NOW()`,
      [
        DEVELOPMENT_VM_ENROLLMENT_ID,
        DEVELOPMENT_VM_ID,
        DEVELOPMENT_WORKSPACE_ID,
        JSON.stringify(READ_ONLY_AGENTV_ACCESS_POLICY),
        hashSecret('development-seed-enrollment-placeholder'),
        createdByUserId
      ]
    );
    await db.query(
      `UPDATE agentv_credentials
       SET state = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
       WHERE target_id = $1 AND id <> $2 AND state IN ('pending', 'active', 'grace')`,
      [DEVELOPMENT_VM_ID, DEVELOPMENT_VM_CREDENTIAL_ID]
    );
    await db.query(
      `INSERT INTO agentv_credentials
         (id, target_id, enrollment_id, key_hash, generation, state, activated_at)
       VALUES ($1, $2, $3, $4, 1, 'active', NOW())
       ON CONFLICT (id) DO UPDATE
       SET key_hash = EXCLUDED.key_hash,
           state = 'active',
           grace_expires_at = NULL,
           replacement_enrollment_id = NULL,
           revoked_at = NULL,
           activated_at = COALESCE(agentv_credentials.activated_at, NOW())`,
      [DEVELOPMENT_VM_CREDENTIAL_ID, DEVELOPMENT_VM_ID, DEVELOPMENT_VM_ENROLLMENT_ID, keyHash]
    );
    await upsertTargetAgentRegistration({
      targetId: DEVELOPMENT_VM_ID,
      targetType: VIRTUAL_MACHINE_TARGET_TYPE,
      workspaceId: DEVELOPMENT_WORKSPACE_ID,
      agentKeyHash: keyHash,
      keyVersion: 1
    });
  }
}

export async function ensureDevelopmentTargetSeed(seedAgentKey?: string, seedVmAgentKey?: string): Promise<void> {
  const user = await upsertUser(DEVELOPMENT_USER_EMAIL, DEVELOPMENT_USER_DISPLAY_NAME);
  await ensureDevelopmentWorkspaceAndTargets(user.id, seedAgentKey, seedVmAgentKey);
}
