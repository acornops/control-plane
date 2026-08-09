import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import {
  parseAgentVAccessPolicy,
  agentVAccessPoliciesEqual,
  READ_ONLY_AGENTV_ACCESS_POLICY,
  type AgentVAccessPolicy
} from '../types/agentv-access-policy.js';
import type { AgentVCredential, AgentVEnrollment, AgentVEnrollmentPurpose } from '../types/agentv-enrollment.js';
import { generateAgentKey, hashSecret, verifySecret } from '../utils/crypto.js';
import { withTransaction } from './repository-transaction.js';

const GRACE_MS = 30 * 60 * 1000;
const TRANSACTION_MS = 60 * 60 * 1000;

interface EnrollmentRow {
  id: string; target_id: string; workspace_id: string; purpose: AgentVEnrollment['purpose'];
  token_hash: string; transaction_secret_hash?: string | null; status: AgentVEnrollment['status'];
  access_policy: unknown;
  expires_at: string | Date; transaction_expires_at?: string | Date | null;
}

interface CredentialRow {
  id: string; target_id: string; enrollment_id: string; key_hash: string; generation: number | string;
  state: AgentVCredential['state'];
}

function enrollment(row: EnrollmentRow): AgentVEnrollment {
  const accessPolicy = parseAgentVAccessPolicy(row.access_policy);
  if (!accessPolicy) throw new Error('Stored AgentV enrollment access policy is invalid');
  return {
    id: row.id, targetId: row.target_id, workspaceId: row.workspace_id, purpose: row.purpose,
    accessPolicy,
    tokenHash: row.token_hash, transactionSecretHash: row.transaction_secret_hash || undefined,
    status: row.status, expiresAt: new Date(row.expires_at).toISOString(),
    transactionExpiresAt: row.transaction_expires_at ? new Date(row.transaction_expires_at).toISOString() : undefined
  };
}

function credential(row: CredentialRow): AgentVCredential {
  return {
    id: row.id, targetId: row.target_id, enrollmentId: row.enrollment_id, keyHash: row.key_hash,
    generation: Number(row.generation), state: row.state
  };
}

function targetAccessPolicy(metadata: Record<string, unknown>): AgentVAccessPolicy {
  const hasPolicy = metadata.agentAccessMode !== undefined || metadata.restartServices !== undefined;
  const parsed = parseAgentVAccessPolicy({
    accessMode: metadata.agentAccessMode,
    restartServices: metadata.restartServices
  });
  if (hasPolicy && !parsed) throw new Error('Stored AgentV target access policy is invalid');
  return parsed || READ_ONLY_AGENTV_ACCESS_POLICY;
}

function clearPendingAccessPolicy(metadata: Record<string, unknown>): void {
  delete metadata.pendingAgentAccessPolicy;
  delete metadata.pendingAgentAccessPolicyEnrollmentId;
}

async function createAgentVEnrollment(input: {
  id: string; targetId: string; workspaceId: string; purpose: AgentVEnrollmentPurpose;
  accessPolicy: AgentVAccessPolicy; tokenHash: string; createdBy: string; expiresAt: string;
  markAccessPolicyUpdate?: boolean;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    const target = await client.query(
      'SELECT id, metadata FROM targets WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [input.targetId, input.workspaceId]
    );
    if (!target.rowCount) return false;
    const active = await client.query(
      "SELECT id FROM agentv_credentials WHERE target_id = $1 AND state = 'active'",
      [input.targetId]
    );
    if ((input.purpose === 'initial' && active.rowCount) || (input.purpose === 'replace' && !active.rowCount)) {
      return false;
    }
    if (input.markAccessPolicyUpdate) {
      if (input.purpose !== 'replace') return false;
      const appliedPolicy = targetAccessPolicy(target.rows[0].metadata || {});
      if (agentVAccessPoliciesEqual(appliedPolicy, input.accessPolicy)) return false;
    }

    // Generating a fresh command is an explicit recovery action. Retire older
    // unconsumed commands and the abandoned pending transaction so a lost
    // exchange response cannot block this target until the cleanup sweep.
    await client.query(
      `UPDATE agentv_enrollments
       SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW()), updated_at = NOW()
       WHERE target_id = $1 AND status = 'issued'`,
      [input.targetId]
    );
    await client.query(
      `UPDATE agentv_enrollments e
       SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW()), updated_at = NOW()
       WHERE e.target_id = $1 AND e.status IN ('exchanged', 'verified')
         AND EXISTS (
           SELECT 1 FROM agentv_credentials c WHERE c.enrollment_id = e.id AND c.state = 'pending'
         )`,
      [input.targetId]
    );
    await client.query(
      `UPDATE agentv_credentials SET state = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
       WHERE target_id = $1 AND state = 'pending'`,
      [input.targetId]
    );
    const metadata = { ...(target.rows[0].metadata || {}) } as Record<string, unknown>;
    clearPendingAccessPolicy(metadata);
    if (input.markAccessPolicyUpdate) {
      metadata.pendingAgentAccessPolicy = input.accessPolicy;
      metadata.pendingAgentAccessPolicyEnrollmentId = input.id;
    }
    await client.query(
      `UPDATE targets SET metadata = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [input.targetId, JSON.stringify(metadata)]
    );
    await client.query(
      `INSERT INTO agentv_enrollments
         (id, target_id, workspace_id, purpose, access_policy, token_hash, status, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'issued', $7, $8)`,
      [input.id, input.targetId, input.workspaceId, input.purpose,
        JSON.stringify(input.accessPolicy),
        input.tokenHash, input.createdBy, input.expiresAt]
    );
    return true;
  });
}

async function lockEnrollment(client: PoolClient, id: string): Promise<AgentVEnrollment | null> {
  const result = await client.query('SELECT * FROM agentv_enrollments WHERE id = $1 FOR UPDATE', [id]);
  return result.rowCount ? enrollment(result.rows[0]) : null;
}

async function exchangeAgentVEnrollment(input: {
  enrollmentId: string; token: string; targetId: string; purpose: AgentVEnrollmentPurpose;
}): Promise<{ enrollment: AgentVEnrollment; agentKey: string; transactionSecret: string } | null> {
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM targets WHERE id = $1 FOR UPDATE', [input.targetId]);
    const current = await lockEnrollment(client, input.enrollmentId);
    if (!current || current.targetId !== input.targetId || current.purpose !== input.purpose || current.status !== 'issued'
      || Date.parse(current.expiresAt) <= Date.now() || !verifySecret(input.token, current.tokenHash)) return null;
    const active = await client.query(
      `SELECT id FROM agentv_credentials WHERE target_id = $1 AND state = 'active' FOR UPDATE`,
      [current.targetId]
    );
    if ((current.purpose === 'initial' && active.rowCount) || (current.purpose === 'replace' && !active.rowCount)) {
      return null;
    }
    const pending = await client.query(
      `SELECT id FROM agentv_credentials WHERE target_id = $1 AND state = 'pending' FOR UPDATE`,
      [current.targetId]
    );
    if (pending.rowCount) return null;
    const generationResult = await client.query(
      'SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM agentv_credentials WHERE target_id = $1',
      [current.targetId]
    );
    const generation = Number(generationResult.rows[0].generation);
    const agentKey = generateAgentKey(current.targetId);
    const transactionSecret = `avt_${randomUUID()}_${randomUUID().replaceAll('-', '')}`;
    const credentialId = randomUUID();
    await client.query(
      `INSERT INTO agentv_credentials (id, target_id, enrollment_id, key_hash, generation, state)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [credentialId, current.targetId, current.id, hashSecret(agentKey), generation]
    );
    const updated = await client.query(
      `UPDATE agentv_enrollments
       SET status = 'exchanged', transaction_secret_hash = $2, exchanged_at = NOW(),
           transaction_expires_at = $3, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [current.id, hashSecret(transactionSecret), new Date(Date.now() + TRANSACTION_MS).toISOString()]
    );
    return { enrollment: enrollment(updated.rows[0]), agentKey, transactionSecret };
  });
}

async function authenticateAgentVCredential(targetId: string, agentKey: string): Promise<{
  credential: AgentVCredential; workspaceId: string; provisional: boolean;
} | null> {
  const result = await db.query(
    `SELECT c.*, e.workspace_id
     FROM agentv_credentials c JOIN agentv_enrollments e ON e.id = c.enrollment_id
     WHERE c.target_id = $1
       AND (c.state = 'active'
         OR (c.state = 'pending' AND e.status IN ('exchanged', 'verified') AND e.transaction_expires_at > NOW())
         OR (c.state = 'grace' AND c.grace_expires_at > NOW()))
     ORDER BY CASE c.state WHEN 'active' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END`,
    [targetId]
  );
  const match = result.rows.find((row) => verifySecret(agentKey, row.key_hash));
  if (!match) return null;
  if (match.state === 'pending') {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE agentv_credentials SET verified_at = COALESCE(verified_at, NOW())
         WHERE id = $1 AND state = 'pending'`, [match.id]
      );
      await client.query(
        `UPDATE agentv_enrollments SET status = 'verified', verified_at = COALESCE(verified_at, NOW()), updated_at = NOW()
         WHERE id = $1 AND status IN ('exchanged', 'verified')`, [match.enrollment_id]
      );
    });
  }
  return { credential: credential(match), workspaceId: match.workspace_id, provisional: match.state === 'pending' };
}

async function isAgentVCredentialAccepted(targetId: string, credentialId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM agentv_credentials
     WHERE id = $1 AND target_id = $2
       AND (state = 'active' OR (state = 'grace' AND grace_expires_at > NOW()))`,
    [credentialId, targetId]
  );
  return Boolean(result.rowCount);
}

async function verifyTransaction(client: PoolClient, id: string, secret: string): Promise<AgentVEnrollment | null> {
  const lookup = await client.query('SELECT target_id FROM agentv_enrollments WHERE id = $1', [id]);
  if (!lookup.rowCount) return null;
  await client.query('SELECT id FROM targets WHERE id = $1 FOR UPDATE', [lookup.rows[0].target_id]);
  const current = await lockEnrollment(client, id);
  return current?.transactionSecretHash && current.transactionExpiresAt
    && Date.parse(current.transactionExpiresAt) > Date.now()
    && verifySecret(secret, current.transactionSecretHash) ? current : null;
}

async function getAgentVInstallationStatus(id: string, secret: string): Promise<{
  enrollment: AgentVEnrollment; credential: AgentVCredential; activeConnected: boolean;
} | null> {
  const result = await db.query(
    `SELECT e.*, c.id AS credential_id, c.key_hash, c.generation, c.state,
            c.activated_at, r.last_heartbeat_at, r.last_authenticated_key_version,
            active.id AS active_credential_id, active.generation AS active_generation,
            active.activated_at AS active_activated_at
     FROM agentv_enrollments e JOIN agentv_credentials c ON c.enrollment_id = e.id
     LEFT JOIN target_agent_registrations r ON r.target_id = e.target_id
     LEFT JOIN agentv_credentials active ON active.target_id = e.target_id AND active.state = 'active'
     WHERE e.id = $1`, [id]
  );
  // Commit and rollback are deliberately limited by transaction_expires_at,
  // but the root-owned boot recovery helper must still be able to distinguish
  // completed, cancelled, and expired final states after a long outage. Keep
  // this endpoint read-only and authenticate it with the same stored hash
  // without reopening the mutation window.
  if (!result.rowCount || !result.rows[0].transaction_secret_hash
    || !verifySecret(secret, result.rows[0].transaction_secret_hash)) return null;
  const row = result.rows[0];
  return {
    enrollment: enrollment(row),
    credential: credential({
      ...row, id: row.credential_id, enrollment_id: row.id
    }),
    activeConnected: Boolean(row.last_heartbeat_at && row.last_authenticated_key_version && (
      row.status === 'completed' && row.state === 'active' && row.activated_at
        ? Number(row.last_authenticated_key_version) === Number(row.generation)
          && new Date(row.last_heartbeat_at).getTime() >= new Date(row.activated_at).getTime()
        : row.status !== 'completed' && row.active_credential_id
          ? Number(row.last_authenticated_key_version) === Number(row.active_generation)
            && new Date(row.last_heartbeat_at).getTime() >= new Date(row.updated_at).getTime()
          : false
    ))
  };
}

async function commitAgentVInstallation(id: string, secret: string): Promise<AgentVCredential | null> {
  return withTransaction(async (client) => {
    const current = await verifyTransaction(client, id, secret);
    if (!current) return null;
    const candidateResult = await client.query(
      'SELECT * FROM agentv_credentials WHERE enrollment_id = $1 FOR UPDATE', [id]
    );
    if (!candidateResult.rowCount) return null;
    const candidate = credential(candidateResult.rows[0]);
    if (current.status === 'completed' && candidate.state === 'active') return candidate;
    if (current.status !== 'verified' || candidate.state !== 'pending') return null;
    const graceExpiresAt = new Date(Date.now() + GRACE_MS).toISOString();
    // Only the credential immediately preceding this replacement is a valid
    // rollback candidate. Revoke older grace generations before promoting
    // the current active credential into the single grace slot.
    await client.query(
      `UPDATE agentv_credentials SET state = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
       WHERE target_id = $1 AND state = 'grace'`, [current.targetId]
    );
    await client.query(
      `UPDATE agentv_credentials
       SET state = 'grace', grace_expires_at = $2, replacement_enrollment_id = $3
       WHERE target_id = $1 AND state = 'active'`, [current.targetId, graceExpiresAt, id]
    );
    const activated = await client.query(
      `UPDATE agentv_credentials SET state = 'active', activated_at = NOW()
       WHERE id = $1 AND state = 'pending' RETURNING *`, [candidate.id]
    );
    await client.query(
      `INSERT INTO target_agent_registrations
         (target_id, workspace_id, agent_key_hash, key_version, capabilities)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (target_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id, agent_key_hash = EXCLUDED.agent_key_hash,
           key_version = EXCLUDED.key_version`,
      [current.targetId, current.workspaceId, activated.rows[0].key_hash, activated.rows[0].generation,
        JSON.stringify(['read', 'logs', 'mcp', 'chat', 'systemd', 'linux'])]
    );
    await client.query(
      `UPDATE agentv_enrollments SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`, [id]
    );
    const target = await client.query('SELECT metadata FROM targets WHERE id = $1 FOR UPDATE', [current.targetId]);
    const metadata = { ...(target.rows[0]?.metadata || {}) } as Record<string, unknown>;
    const isAccessPolicyUpdate = metadata.pendingAgentAccessPolicyEnrollmentId === id;
    if (isAccessPolicyUpdate) {
      metadata.agentAccessMode = current.accessPolicy.accessMode;
      metadata.restartServices = current.accessPolicy.restartServices;
      clearPendingAccessPolicy(metadata);
    }
    await client.query(
      `UPDATE targets SET metadata = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [current.targetId, JSON.stringify(metadata)]
    );
    return credential(activated.rows[0]);
  });
}

async function rollbackAgentVInstallation(id: string, secret: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const current = await verifyTransaction(client, id, secret);
    if (!current) return false;
    if (current.status === 'cancelled') return true;
    const candidateResult = await client.query(
      'SELECT * FROM agentv_credentials WHERE enrollment_id = $1 FOR UPDATE', [id]
    );
    if (!candidateResult.rowCount) return false;
    const candidate = credential(candidateResult.rows[0]);
    const target = await client.query('SELECT metadata FROM targets WHERE id = $1 FOR UPDATE', [current.targetId]);
    const metadata = { ...(target.rows[0]?.metadata || {}) } as Record<string, unknown>;
    if (current.status === 'completed') {
      const previous = await client.query(
        `SELECT c.*, e.access_policy AS enrollment_access_policy
         FROM agentv_credentials c
         JOIN agentv_enrollments e ON e.id = c.enrollment_id
         WHERE c.target_id = $1 AND c.state = 'grace' AND c.replacement_enrollment_id = $2
           AND c.grace_expires_at > NOW() FOR UPDATE OF c`, [current.targetId, id]
      );
      if (current.purpose === 'replace' && !previous.rowCount) return false;
      await client.query(
        `UPDATE agentv_credentials SET state = 'revoked', revoked_at = NOW()
         WHERE id = $1 AND state = 'active'`, [candidate.id]
      );
      if (previous.rowCount) {
        await client.query(
          `UPDATE agentv_credentials
           SET state = 'active', grace_expires_at = NULL, replacement_enrollment_id = NULL
           WHERE id = $1`, [previous.rows[0].id]
        );
        await client.query(
          `UPDATE target_agent_registrations SET agent_key_hash = $2, key_version = $3 WHERE target_id = $1`,
          [current.targetId, previous.rows[0].key_hash, previous.rows[0].generation]
        );
      } else {
        await client.query('DELETE FROM target_agent_registrations WHERE target_id = $1', [current.targetId]);
      }
      if (previous.rowCount) {
        const rollbackPolicy = parseAgentVAccessPolicy(previous.rows[0].enrollment_access_policy);
        if (!rollbackPolicy) throw new Error('Stored AgentV enrollment access policy is invalid');
        if (!agentVAccessPoliciesEqual(rollbackPolicy, current.accessPolicy)) {
          metadata.agentAccessMode = rollbackPolicy.accessMode;
          metadata.restartServices = rollbackPolicy.restartServices;
        }
      }
    } else if (metadata.pendingAgentAccessPolicyEnrollmentId === id) {
      clearPendingAccessPolicy(metadata);
    }
    await client.query(
      `UPDATE agentv_credentials SET state = 'revoked', revoked_at = NOW()
       WHERE id = $1 AND state IN ('pending', 'active')`, [candidate.id]
    );
    await client.query(
      `UPDATE agentv_enrollments SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW()), updated_at = NOW()
       WHERE id = $1`, [id]
    );
    await client.query(
      `UPDATE targets SET metadata = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [current.targetId, JSON.stringify(metadata)]
    );
    return true;
  });
}

async function expireAgentVEnrollmentState(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agentv_enrollments SET status = 'expired', expired_at = COALESCE(expired_at, NOW()), updated_at = NOW()
       WHERE status = 'issued' AND expires_at <= NOW()`
    );
    await client.query(
      `UPDATE agentv_enrollments SET status = 'expired', expired_at = COALESCE(expired_at, NOW()), updated_at = NOW()
       WHERE status IN ('exchanged', 'verified') AND transaction_expires_at <= NOW()`
    );
    await client.query(
      `UPDATE agentv_credentials SET state = 'revoked', revoked_at = NOW()
       WHERE state = 'pending' AND enrollment_id IN (
         SELECT id FROM agentv_enrollments WHERE status IN ('expired', 'cancelled')
       )`
    );
    await client.query(
      `UPDATE agentv_credentials SET state = 'revoked', revoked_at = NOW()
       WHERE state = 'grace' AND grace_expires_at <= NOW()`
    );
    await client.query(
      `UPDATE targets
       SET metadata = metadata - 'pendingAgentAccessPolicy' - 'pendingAgentAccessPolicyEnrollmentId', updated_at = NOW()
       WHERE metadata->>'pendingAgentAccessPolicyEnrollmentId' IN (
         SELECT id FROM agentv_enrollments WHERE status IN ('expired', 'cancelled')
       )`
    );
  });
}

export const agentVEnrollmentRepository = {
  createAgentVEnrollment,
  exchangeAgentVEnrollment,
  authenticateAgentVCredential,
  isAgentVCredentialAccepted,
  getAgentVInstallationStatus,
  commitAgentVInstallation,
  rollbackAgentVInstallation,
  expireAgentVEnrollmentState
};
