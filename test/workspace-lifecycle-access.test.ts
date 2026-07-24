import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { getWorkspaceRole, getWorkspaceSummaryForUser, listWorkspacesForUser, userHasWorkspaceAccess } from '../src/store/repository-users.js';
import { acceptWorkspaceInvitation } from '../src/store/repository-invitations.js';

afterEach(() => mock.restoreAll());

describe('workspace lifecycle access boundary', () => {
  it('requires active lifecycle state for tenant discovery and membership authorization', async () => {
    const statements: string[] = [];
    mock.method(db, 'query', async (sql: string) => {
      statements.push(sql);
      return { rowCount: 0, rows: [] } as never;
    });

    await listWorkspacesForUser('user-1');
    await getWorkspaceSummaryForUser('user-1', 'workspace-1');
    await userHasWorkspaceAccess('user-1', 'workspace-1');
    await getWorkspaceRole('user-1', 'workspace-1');

    assert.equal(statements.length, 4);
    for (const sql of statements) assert.match(sql, /w\.lifecycle_status = 'active'/);
  });

  it('does not accept an invitation while its workspace is suspended', async () => {
    const client = {
      query: async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (sql.includes('FROM workspace_invitations i')) {
          return {
            rowCount: 1,
            rows: [{
              id: 'invite-1', workspace_id: 'workspace-1', workspace_name: 'Atlas Research', lifecycle_status: 'suspended',
              email: 'user@example.test', role: 'member', invited_by: 'owner-1', status: 'pending', accepted_by: null,
              created_at: '2026-07-17T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', accepted_at: null, revoked_at: null
            }]
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client as never);

    assert.deepEqual(await acceptWorkspaceInvitation('token-hash', 'user-1'), { status: 'workspace_suspended' });
  });
});
