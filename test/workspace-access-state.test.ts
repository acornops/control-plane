import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { db } from '../src/infra/db.js';
import { getMemberWorkspaceAccessState } from '../src/store/repository-workspace-access-state.js';
afterEach(() => mock.restoreAll());
test('suspended member projection contains only the safe explanation, never private governance fields', async () => {
  mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{ id: 'w', name: 'Workspace', lifecycle_status: 'suspended', public_reason: 'Contact your administrator', suspended_at: new Date('2026-09-06'), reason: 'private', token_id: 'secret' }] }) as never);
  assert.deepEqual(await getMemberWorkspaceAccessState('user', 'w'), {
    id: 'w', name: 'Workspace', accessState: 'suspended', publicReason: 'Contact your administrator', suspendedAt: '2026-09-06T00:00:00.000Z'
  });
});
test('nonmembers receive no workspace metadata', async () => {
  mock.method(db, 'query', async (sql: string, args: unknown[]) => {
    assert.match(sql, /workspace_memberships/);
    assert.deepEqual(args, ['user', 'w']);
    return { rowCount: 0, rows: [] } as never;
  });
  assert.equal(await getMemberWorkspaceAccessState('user', 'w'), null);
});
