import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { DEVELOPMENT_WORKSPACE_ID } from '../src/constants/dev-defaults.js';
import { db } from '../src/infra/db.js';
import { ensureDevelopmentWorkspaceAndTargets } from '../src/store/repository-development-seed.js';
import { hashToken } from '../src/utils/crypto.js';

afterEach(() => {
  mock.restoreAll();
});

describe('development workspace seed', () => {
  it('seeds realistic members and pending invitation states for local UI review', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rowCount: 1, rows: [] };
    });

    await ensureDevelopmentWorkspaceAndTargets(
      'owner-user',
      undefined,
      undefined,
      [
        { userId: 'backup-owner-user', role: 'owner' },
        { userId: 'admin-user', role: 'admin' },
        { userId: 'operator-user', role: 'operator' },
        { userId: 'viewer-user', role: 'viewer' },
        { userId: 'auditor-user', role: 'auditor' }
      ],
      true,
      [
        {
          email: 'new.admin.invite@acornops.local',
          role: 'admin',
          status: 'pending',
          createdOffsetDays: -1,
          expiresOffsetDays: 6,
          token: 'wi_dev_pending_admin'
        },
        {
          email: 'expired.auditor.invite@acornops.local',
          role: 'auditor',
          status: 'expired',
          createdOffsetDays: -14,
          expiresOffsetDays: -7,
          token: 'wi_dev_expired_auditor'
        }
      ]
    );

    const membershipQueries = queries.filter(({ sql }) => sql.includes('INSERT INTO workspace_memberships'));
    assert.equal(membershipQueries.length, 6);
    assert(membershipQueries.every(({ params }) => params[0] === DEVELOPMENT_WORKSPACE_ID));
    assert(membershipQueries.every(({ sql }) => sql.includes('DO UPDATE')));
    assert.deepEqual(
      membershipQueries.map(({ params }) => params[2]),
      ['owner', 'owner', 'admin', 'operator', 'viewer', 'auditor']
    );

    const invitationQueries = queries.filter(({ sql }) => sql.includes('INSERT INTO workspace_invitations'));
    assert.equal(invitationQueries.length, 2);
    assert.deepEqual(invitationQueries[0].params, [
      'dev-invite-new.admin.invite@acornops.local',
      DEVELOPMENT_WORKSPACE_ID,
      'new.admin.invite@acornops.local',
      'admin',
      hashToken('wi_dev_pending_admin'),
      'owner-user',
      'pending',
      -1,
      6
    ]);
    assert.deepEqual(invitationQueries[1].params, [
      'dev-invite-expired.auditor.invite@acornops.local',
      DEVELOPMENT_WORKSPACE_ID,
      'expired.auditor.invite@acornops.local',
      'auditor',
      hashToken('wi_dev_expired_auditor'),
      'owner-user',
      'expired',
      -14,
      -7
    ]);
  });
});
