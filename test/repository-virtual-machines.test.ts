import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { db } from '../src/infra/db.js';
import { listVirtualMachines } from '../src/store/repository-virtual-machines.js';

describe('virtual machine repository reads', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('keeps offline status filters compatible with setup-required VMs', async () => {
    let capturedSql = '';
    mock.method(db, 'query', async (sql: string) => {
      capturedSql = sql;
      return { rows: [], rowCount: 0 };
    });

    await listVirtualMachines('workspace-1', { status: 'offline' });

    assert.match(capturedSql, /status = \$3 OR status = 'unknown'/);
  });

  it('keeps explicit setup-required filters exact', async () => {
    let capturedSql = '';
    mock.method(db, 'query', async (sql: string) => {
      capturedSql = sql;
      return { rows: [], rowCount: 0 };
    });

    await listVirtualMachines('workspace-1', { status: 'unknown' });

    assert.match(capturedSql, /status = \$3/);
    assert.doesNotMatch(capturedSql, /OR status = 'unknown'/);
  });
});
