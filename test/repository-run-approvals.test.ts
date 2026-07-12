import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { countPendingWorkspaceRunToolApprovals } from '../src/store/repository-run-approvals.js';

afterEach(() => mock.restoreAll());

describe('run approval repository', () => {
  it('counts only persisted pending approvals in the requested workspace', async () => {
    let statement = '';
    let values: unknown[] | undefined;
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      statement = sql;
      values = params;
      return { rowCount: 1, rows: [{ count: '104' }] };
    });

    const count = await countPendingWorkspaceRunToolApprovals('workspace-isolated');

    assert.equal(count, 104);
    assert.deepEqual(values, ['workspace-isolated']);
    assert.match(statement, /workspace_id = \$1/);
    assert.match(statement, /status = 'pending'/);
    assert.doesNotMatch(statement, /LIMIT|OFFSET|created_at/i);
  });
});
