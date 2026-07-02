import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { db } from '../src/infra/db.js';
import { listVirtualMachines, upsertVirtualMachineSnapshot } from '../src/store/repository-virtual-machines.js';

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

  it('normalizes VM snapshot finding severity before latest finding insert', async () => {
    let insertedFindings: Array<Record<string, unknown>> = [];
    const statements: string[] = [];
    const queryParams: unknown[][] = [];
    mock.method(db, 'query', async (sql: string) => {
      if (sql.includes("WHERE id = $1 AND target_type = 'virtual_machine'")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 'vm-1',
              workspace_id: 'workspace-1',
              target_type: 'virtual_machine',
              name: 'vm-1',
              status: 'online',
              metadata: { hostname: 'vm-1.local' },
              created_at: '2026-05-10T00:00:00.000Z',
              updated_at: '2026-05-10T00:00:00.000Z'
            }
          ]
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        queryParams.push(params ?? []);
        if (sql.includes('INSERT INTO target_findings')) {
          insertedFindings = JSON.parse(String(params?.[0])) as Array<Record<string, unknown>>;
        }
        if (sql.includes('INSERT INTO target_issues') && sql.includes('RETURNING id')) {
          return { rowCount: 1, rows: [{ id: 'issue-1' }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    await upsertVirtualMachineSnapshot({
      targetId: 'vm-1',
      workspaceId: 'workspace-1',
      timestamp: '2026-05-10T00:00:00.000Z',
      data: {
        metrics: {
          loadAverage: [0.1, 0.2, 0.3],
          cpuUsagePercent: 7.5,
          memory: { totalBytes: 1024, usedBytes: 512 },
          swap: { totalBytes: 2048, usedBytes: 256 },
          disks: [{ mountpoint: '/', usedBytes: 128 }]
        },
        findings: [
          {
            id: 'finding-1',
            severity: 'error',
            title: 'Unexpected service state',
            message: 'Service emitted a non-standard severity.',
            reason: 'unexpected',
            objectKind: 'host',
            objectName: 'vm-1.local',
            timestamp: '2026-05-10T00:00:00.000Z'
          }
        ]
      }
    });

    const metricHistoryIndex = statements.findIndex((sql) => sql.includes('INSERT INTO target_metric_history'));
    assert.notEqual(metricHistoryIndex, -1);
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_snapshot_history')));
    assert.deepEqual(JSON.parse(String(queryParams[metricHistoryIndex][4])), {
      loadAverage: [0.1, 0.2, 0.3],
      cpuUsagePercent: 7.5,
      memory: { totalBytes: 1024, usedBytes: 512 },
      swap: { totalBytes: 2048, usedBytes: 256 },
      disks: [{ mountpoint: '/', usedBytes: 128 }]
    });
    assert.equal(insertedFindings[0]?.severity, 'info');
    assert.equal(insertedFindings[0]?.severity_rank, 2);
  });

  it('ignores older VM snapshots without replacing latest rows, writing metrics, or reconciling issues', async () => {
    mock.method(db, 'query', async (sql: string) => {
      if (sql.includes("WHERE id = $1 AND target_type = 'virtual_machine'")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 'vm-1',
              workspace_id: 'workspace-1',
              target_type: 'virtual_machine',
              name: 'vm-1',
              status: 'online',
              metadata: { hostname: 'vm-1.local' },
              created_at: '2026-05-10T00:00:00.000Z',
              updated_at: '2026-05-10T00:00:00.000Z'
            }
          ]
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM target_snapshots')) {
          return {
            rowCount: 1,
            rows: [{ snapshot_ts: '2026-05-10T00:05:00.000Z' }]
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    await upsertVirtualMachineSnapshot({
      targetId: 'vm-1',
      workspaceId: 'workspace-1',
      timestamp: '2026-05-10T00:04:00.000Z',
      data: {
        host: { hostname: 'vm-1.local' },
        findings: [
          {
            id: 'finding-1',
            severity: 'critical',
            title: 'Host pressure',
            message: 'Host has pressure.',
            reason: 'pressure',
            objectKind: 'host',
            objectName: 'vm-1.local',
            timestamp: '2026-05-10T00:04:00.000Z'
          }
        ]
      }
    });

    assert(!statements.some((sql) => sql.includes('INSERT INTO target_snapshot_history')));
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_metric_history')));
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_snapshots')));
    assert(!statements.some((sql) => sql.includes('DELETE FROM target_inventory_items')));
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_issues')));
  });
});
