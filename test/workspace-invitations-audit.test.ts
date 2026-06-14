import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { acceptWorkspaceInvitation } from '../src/store/repository-invitations.js';

afterEach(() => {
  mock.restoreAll();
});

describe('workspace invitation audit events', () => {
  it('records the accepting user as actor and keeps inviter as metadata', async () => {
    let auditParams: unknown[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (sql.includes('FROM workspace_invitations i') && sql.includes('WHERE i.token_hash = $1')) {
          return {
            rowCount: 1,
            rows: [{
              id: 'invite-1',
              workspace_id: 'workspace-1',
              workspace_name: 'Workspace',
              email: 'invitee@example.test',
              role: 'auditor',
              invited_by: 'inviter-1',
              status: 'pending',
              accepted_by: null,
              created_at: '2026-05-30T00:00:00.000Z',
              expires_at: '2099-01-01T00:00:00.000Z',
              accepted_at: null,
              revoked_at: null
            }]
          };
        }
        if (sql.includes('SELECT * FROM users')) {
          return {
            rowCount: 1,
            rows: [{ id: 'invitee-1', email: 'invitee@example.test', display_name: 'Invitee' }]
          };
        }
        if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) {
          return { rowCount: 1, rows: [{ id: 'invitee-1' }] };
        }
        if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) {
          return { rowCount: 1, rows: [{ plan_key: 'default' }] };
        }
        if (sql.includes('FROM workspace_quota_overrides')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM workspace_memberships m') && sql.includes('LIMIT 1')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships')) {
          return { rowCount: 1, rows: [{ count: 0 }] };
        }
        if (sql.includes('INSERT INTO workspace_memberships')) {
          return {
            rowCount: 1,
            rows: [{
              workspace_id: 'workspace-1',
              user_id: 'invitee-1',
              email: 'invitee@example.test',
              display_name: 'Invitee',
              role: 'auditor',
              source: 'internal',
              created_at: '2026-05-30T00:00:00.000Z',
              updated_at: '2026-05-30T00:00:00.000Z'
            }]
          };
        }
        if (sql.includes('UPDATE workspace_invitations SET status =')) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO workspace_audit_events')) {
          auditParams = params ?? [];
          return {
            rowCount: 1,
            rows: [{
              id: 'audit-1',
              workspace_id: 'workspace-1',
              category: 'membership',
              event_type: 'workspace.member.added.v1',
              operation: 'write',
              actor_type: 'user',
              actor_user_id: 'invitee-1',
              actor_email: null,
              actor_display_name: null,
              actor_token_id: null,
              object_type: 'member',
              object_id: 'invitee-1',
              object_name: null,
              summary: 'Workspace member added from invitation',
              metadata: {},
              occurred_at: '2026-05-30T00:00:00.000Z'
            }]
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    const result = await acceptWorkspaceInvitation('token-hash', 'invitee-1');

    assert.equal(result.status, 'accepted');
    assert.equal(auditParams[4], 'write');
    assert.equal(auditParams[6], 'invitee-1');
    assert.equal(JSON.parse(auditParams[12] as string).invitedBy, 'inviter-1');
  });
});
