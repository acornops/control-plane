import { randomUUID } from 'node:crypto';
import { insertWorkspaceAuditEvent } from '../store/repository-audit-events.js';
import { mapWorkspace } from '../store/repository-mappers.js';
import { assertWorkspaceMemberQuota, assertWorkspaceMembershipQuota } from '../store/repository-quotas.js';
import { withTransaction } from '../store/repository-transaction.js';
import type { Workspace } from '../types/domain.js';
import {
  recordStarterAutomationSeedFailure,
  recordStarterAutomationSeedSuccess,
  refreshStarterAutomationReadiness,
  seedStarterAutomationV1InTransaction
} from './automation-templates.js';

export interface WorkspaceProvisioningInput {
  id?: string;
  name: string;
  createdBy: string;
  membershipSource?: 'oidc' | 'internal';
  idempotent?: boolean;
  enforceQuotas?: boolean;
}

export async function provisionWorkspaceWithStarterAutomationV1(
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
      if (input.idempotent) {
        await client.query(
          `INSERT INTO workspace_memberships (workspace_id,user_id,role,source)
           VALUES ($1,$2,'owner',$3)
           ON CONFLICT (workspace_id,user_id) DO UPDATE
           SET role=EXCLUDED.role,source=EXCLUDED.source,updated_at=NOW()`,
          [workspaceId, input.createdBy, input.membershipSource || 'oidc']
        );
      } else {
        await client.query(
          `INSERT INTO workspace_memberships (workspace_id,user_id,role,source)
           VALUES ($1,$2,'owner',$3)`,
          [workspaceId, input.createdBy, input.membershipSource || 'oidc']
        );
      }

      seedAttempted = true;
      const seed = await seedStarterAutomationV1InTransaction(client, {
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
      return { workspace: mapWorkspace(workspaceRow), created, seed };
    });

    recordStarterAutomationSeedSuccess(workspaceId, result.seed.alreadySeeded);
    if (!result.seed.alreadySeeded) await refreshStarterAutomationReadiness(result.seed.installation);
    return { workspace: result.workspace, created: result.created };
  } catch (error) {
    if (seedAttempted) recordStarterAutomationSeedFailure(workspaceId, error);
    throw error;
  }
}
