import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { deleteCluster } from '../src/store/repository-kubernetes-clusters.js';
import { deleteWorkspace } from '../src/store/repository-workspaces.js';

afterEach(() => {
  mock.restoreAll();
});

function installTransactionMock(
  handler: (sql: string, params: unknown[]) => { rowCount?: number; rows?: unknown[] }
): { statements: string[]; params: unknown[][] } {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const client = {
    query: async (sql: string, queryParams?: unknown[]) => {
      statements.push(sql);
      params.push(queryParams ?? []);
      return handler(sql, queryParams ?? []);
    },
    release: () => undefined
  };
  mock.method(db, 'connect', async () => client);
  return { statements, params };
}

describe('target delete cleanup', () => {
  it('removes target-scoped webhook history before deleting a Kubernetes target', async () => {
    const { statements } = installTransactionMock((sql) => {
      if (sql.includes('SELECT 1 FROM targets')) {
        return { rowCount: 1, rows: [{ '?column?': 1 }] };
      }
      return { rowCount: 1, rows: [] };
    });

    assert.equal(await deleteCluster('cluster-1'), true);

    const historyDelete = statements.findIndex((sql) => sql === 'DELETE FROM webhook_history WHERE target_id = $1');
    const subscriptionDelete = statements.findIndex((sql) => sql === 'DELETE FROM webhook_subscriptions WHERE target_id = $1');
    const targetDelete = statements.findIndex((sql) => sql === 'DELETE FROM targets WHERE id = $1');

    assert.notEqual(historyDelete, -1);
    assert.notEqual(subscriptionDelete, -1);
    assert.notEqual(targetDelete, -1);
    assert(historyDelete < subscriptionDelete);
    assert(subscriptionDelete < targetDelete);
    assert.equal(statements.at(-1), 'COMMIT');
  });

  it('removes workspace-owned rows that can block workspace deletion', async () => {
    const { statements } = installTransactionMock((sql) => {
      if (sql.includes('SELECT 1 FROM workspaces')) {
        return { rowCount: 1, rows: [{ '?column?': 1 }] };
      }
      if (sql.includes('SELECT id FROM targets')) {
        return { rowCount: 2, rows: [{ id: 'target-1' }, { id: 'target-2' }] };
      }
      return { rowCount: 1, rows: [] };
    });

    assert.equal(await deleteWorkspace('workspace-1'), true);

    assert(statements.some((sql) => sql === 'DELETE FROM webhook_history WHERE workspace_id = $1'));
    assert(statements.some((sql) => sql === 'DELETE FROM workspace_invitations WHERE workspace_id = $1'));
    assert(statements.some((sql) => sql === 'DELETE FROM workspace_audit_events WHERE workspace_id = $1'));
    assert(statements.some((sql) => sql === 'DELETE FROM workspace_membership_audit WHERE workspace_id = $1'));
    assert(statements.some((sql) => sql === 'DELETE FROM workspaces WHERE id = $1'));
    assert.equal(statements.at(-1), 'COMMIT');
  });
});
