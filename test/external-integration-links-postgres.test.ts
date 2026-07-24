import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  completeExternalIntegrationLinkToken,
  resolveExternalIntegrationUserLink
} from '../src/store/repository-external-integration-links.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await db.query(
    'TRUNCATE TABLE external_integration_link_tokens, external_integration_user_links, account_audit_events CASCADE'
  );
});

after(closeAutomationDatabaseFixtures);

describe('external integration link transactions', () => {
  it('commits the link, grants, token consumption, audit, and authentication timestamp together', async () => {
    await db.query(
      `INSERT INTO external_integration_link_tokens (
         id,token_hash,integration_client_id,provider,client_display_name,
         external_user_id,external_display_name,expires_at
       ) VALUES ('token-1','hash-1','mattermost','mattermost','Mattermost','external-user-1','Ryan',NOW()+INTERVAL '10 minutes')`
    );

    const link = await completeExternalIntegrationLinkToken({
      tokenHash: 'hash-1',
      acornopsUserId: 'user-1',
      linkExpiresAt: new Date(Date.now() + 60_000),
      workspaceGrants: [{ workspaceId: 'workspace-1', capabilities: ['read_workspace_data', 'create_sessions'] }],
      auditCompletion: true
    });

    assert.ok(link);
    assert.deepEqual(link.grants.map((grant) => ({
      workspaceId: grant.workspaceId,
      capabilities: grant.capabilities
    })), [{
      workspaceId: 'workspace-1',
      capabilities: ['read_workspace_data', 'create_sessions']
    }]);

    const committed = await db.query<{
      consumed: boolean;
      grant_count: number;
      audit_count: number;
    }>(
      `SELECT
         (SELECT consumed_at IS NOT NULL FROM external_integration_link_tokens WHERE token_hash='hash-1') AS consumed,
         (SELECT COUNT(*)::int FROM external_integration_workspace_grants WHERE external_integration_user_link_id=$1) AS grant_count,
         (SELECT COUNT(*)::int FROM account_audit_events WHERE object_id=$1 AND event_type='external_integration.link.completed.v1') AS audit_count`,
      [link.id]
    );
    assert.deepEqual(committed.rows[0], { consumed: true, grant_count: 1, audit_count: 1 });

    await db.query(
      `UPDATE external_integration_user_links
       SET last_authenticated_at='2026-01-01T00:00:00.000Z'
       WHERE id=$1`,
      [link.id]
    );
    const resolution = await resolveExternalIntegrationUserLink({
      integrationClientId: 'mattermost',
      provider: 'mattermost',
      externalUserId: 'external-user-1'
    });
    assert.ok(resolution);
    assert.ok(new Date(resolution.link.lastAuthenticatedAt).getTime() > new Date('2026-01-01T00:00:00.000Z').getTime());
  });

  it('rolls back the link and token consumption when a workspace grant cannot be stored', async () => {
    await db.query(
      `INSERT INTO external_integration_link_tokens (
         id,token_hash,integration_client_id,provider,client_display_name,
         external_user_id,expires_at
       ) VALUES ('token-2','hash-2','mattermost','mattermost','Mattermost','external-user-2',NOW()+INTERVAL '10 minutes')`
    );

    await assert.rejects(completeExternalIntegrationLinkToken({
      tokenHash: 'hash-2',
      acornopsUserId: 'user-1',
      linkExpiresAt: new Date(Date.now() + 60_000),
      workspaceGrants: [{ workspaceId: 'missing-workspace', capabilities: ['read_workspace_data'] }],
      auditCompletion: true
    }));

    const rolledBack = await db.query<{
      consumed: boolean;
      link_count: number;
      audit_count: number;
    }>(
      `SELECT
         (SELECT consumed_at IS NOT NULL FROM external_integration_link_tokens WHERE token_hash='hash-2') AS consumed,
         (SELECT COUNT(*)::int FROM external_integration_user_links WHERE external_user_id='external-user-2') AS link_count,
         (SELECT COUNT(*)::int FROM account_audit_events WHERE event_type='external_integration.link.completed.v1') AS audit_count`
    );
    assert.deepEqual(rolledBack.rows[0], { consumed: false, link_count: 0, audit_count: 0 });
  });
});
