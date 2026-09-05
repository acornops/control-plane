import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { insertWorkspaceAuditEvent } from '../store/repository-audit-events.js';
import { mapWorkspace } from '../store/repository-mappers.js';
import { assertWorkspaceMemberQuota, assertWorkspaceMembershipQuota } from '../store/repository-quotas.js';
import { withTransaction } from '../store/repository-transaction.js';
import { initializeWorkspaceDefaults } from '../store/repository-workspace-defaults.js';
import { readWorkspaceMemberMcpLifecycleInTransaction } from '../store/repository-mcp-user-lifecycle.js';
import type { Workspace } from '../types/domain.js';
import {
  recordStarterAutomationSeedFailure,
  recordStarterAutomationSeedSuccess,
  refreshStarterAutomationReadiness,
  provisionStarterAutomationInTransaction
} from './automation-templates.js';
import { reconcileWorkspaceMemberMcpLifecycle } from './mcp-user-lifecycle-worker.js';

export interface WorkspaceProvisioningInput {
  id?: string;
  name: string;
  createdBy: string;
  membershipSource?: 'oidc' | 'internal';
  idempotent?: boolean;
  enforceQuotas?: boolean;
}

export async function provisionWorkspaceWithStarterAutomation(
  input: WorkspaceProvisioningInput
): Promise<{ workspace: Workspace; created: boolean }> {
  const workspaceId = input.id || randomUUID();
  let seedAttempted = false;
  try {
    const result = await withTransaction(async (client) => {
      if (input.enforceQuotas !== false) await assertWorkspaceMembershipQuota(client, input.createdBy);
      const workspaceResult = input.idempotent
        ? await client.query(
          `INSERT INTO workspaces (id,name,created_by,created_at)
           VALUES ($1,$2,$3,NOW())
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [workspaceId, input.name, input.createdBy]
        )
        : await client.query(
          `INSERT INTO workspaces (id,name,created_by,created_at)
           VALUES ($1,$2,$3,NOW())
           RETURNING *`,
          [workspaceId, input.name, input.createdBy]
        );
      const created = Boolean(workspaceResult.rowCount);
      const workspaceRow = created
        ? workspaceResult.rows[0]
        : (await client.query('SELECT * FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0];
      if (!workspaceRow) throw new Error('Workspace provisioning target disappeared');

      if (input.enforceQuotas !== false && created) await assertWorkspaceMemberQuota(client, workspaceId);
      const existingMembership = input.idempotent
        ? await client.query(
          `SELECT 1 FROM workspace_memberships
           WHERE workspace_id=$1 AND user_id=$2
           FOR UPDATE`,
          [workspaceId, input.createdBy]
        )
        : undefined;
      const membershipCreated = !existingMembership?.rowCount;
      if (existingMembership?.rowCount) {
        await client.query(
          `UPDATE workspace_memberships
           SET role='owner',source=$3,updated_at=NOW()
           WHERE workspace_id=$1 AND user_id=$2`,
          [workspaceId, input.createdBy, input.membershipSource || 'oidc']
        );
      } else {
        const membershipSource = input.membershipSource || 'oidc';
        await client.query(input.idempotent
          ? `INSERT INTO workspace_memberships (workspace_id,user_id,role,source)
             VALUES ($1,$2,'owner',$3)
             ON CONFLICT (workspace_id,user_id) DO UPDATE
             SET role='owner',source=EXCLUDED.source,updated_at=NOW()`
          : `INSERT INTO workspace_memberships (workspace_id,user_id,role,source)
             VALUES ($1,$2,'owner',$3)`,
        [workspaceId, input.createdBy, membershipSource]);
      }
      const membershipLifecycle = membershipCreated
        ? await readWorkspaceMemberMcpLifecycleInTransaction(
          client,
          workspaceId,
          input.createdBy,
          'active'
        )
        : undefined;

      if (created) await initializeWorkspaceDefaults(client, workspaceId);

      seedAttempted = true;
      const seed = await provisionStarterAutomationInTransaction(client, {
        workspaceId,
        installedBy: input.createdBy
      });
      if (created) {
        await insertWorkspaceAuditEvent({
          workspaceId,
          category: 'workspace',
          eventType: 'workspace.created.v1',
          operation: 'write',
          actorUserId: input.createdBy,
          objectType: 'workspace',
          objectId: workspaceId,
          objectName: workspaceRow.name,
          summary: 'Workspace created',
          metadata: { name: workspaceRow.name }
        }, client);
      }
      return { workspace: mapWorkspace(workspaceRow), created, seed, membershipLifecycle };
    });

    recordStarterAutomationSeedSuccess(workspaceId, result.seed.alreadySeeded);
    if (!result.seed.alreadySeeded) await refreshStarterAutomationReadiness(result.seed.installation);
    seedAttempted = false;
    if (result.membershipLifecycle) {
      try {
        await reconcileWorkspaceMemberMcpLifecycle({
          workspaceId,
          userId: input.createdBy,
          membershipGeneration: result.membershipLifecycle.membershipGeneration,
          status: 'active'
        });
      } catch (error) {
        if (!result.created) throw error;
        logger.warn({
          err: error,
          workspaceId,
          userId: input.createdBy,
          membershipGeneration: result.membershipLifecycle.membershipGeneration
        }, 'New workspace MCP owner activation is pending durable background reconciliation');
      }
    }
    return { workspace: result.workspace, created: result.created };
  } catch (error) {
    if (seedAttempted) recordStarterAutomationSeedFailure(workspaceId, error);
    throw error;
  }
}
