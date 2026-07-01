import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  upsertClusterSnapshot
} from '../src/store/repository-kubernetes-clusters.js';
import {
  listClusterSnapshotResources
} from '../src/store/repository-kubernetes-inventory.js';

afterEach(() => {
  mock.restoreAll();
});

describe('normalized snapshot repository reads', () => {
  it('queries resource rows with SQL filters and sort-key pagination', async () => {
    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      assert.match(sql, /FROM target_inventory_items r/);
      assert.match(sql, /r\.category = \$2/);
      assert.match(sql, /r\.kind = \$3/);
      assert.match(sql, /r\.scope_name = \$4/);
      assert.match(sql, /r\.needs_attention = \$5/);
      assert.match(sql, /r\.search_text LIKE \$6/);
      assert.match(sql, /LOWER\(t\.name\) LIKE \$6/);
      assert.match(sql, /r\.sort_key > \$7/);
      assert.deepEqual(params, [
        'cluster-1',
        'workloads',
        'Pod',
        'default',
        true,
        '%pod\\%\\_one%',
        'workloads:Pod:default:pod-0:pod-0',
        3
      ]);
      return {
        rows: [
          {
            item_id: 'pod-1',
            family: 'workloads',
            kind: 'Pod',
            namespace: 'default',
            name: 'pod-1',
            status: 'Pending',
            node: 'node-1',
            item: { name: 'pod-1' },
            cluster_id: 'cluster-1',
            cluster_name: 'cluster-1',
            sort_key: 'workloads:Pod:default:pod-1:pod-1'
          }
        ]
      };
    });

    const page = await listClusterSnapshotResources('cluster-1', {
      limit: 2,
      cursor: { sortKey: 'workloads:Pod:default:pod-0:pod-0' },
      q: 'pod%_one',
      family: 'workloads',
      kind: 'Pod',
      namespace: 'default',
      health: 'attention',
      signature: 'sig'
    });

    assert.deepEqual(page.items, [
      {
        id: 'pod-1',
        family: 'workloads',
        kind: 'Pod',
        name: 'pod-1',
        namespace: 'default',
        status: 'Pending',
        node: 'node-1',
        clusterId: 'cluster-1',
        clusterName: 'cluster-1',
        item: { name: 'pod-1' }
      }
    ]);
  });

});

describe('normalized snapshot repository ingest', () => {
  it('writes compact metric history and replaces normalized latest rows in one transaction', async () => {
    const statements: string[] = [];
    const queryParams: unknown[][] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        queryParams.push(params ?? []);
        if (sql.includes('INSERT INTO target_issues') && sql.includes('RETURNING id')) {
          return { rowCount: 1, rows: [{ id: 'issue-1' }] };
        }
        if (sql.includes('FROM target_issues')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM targets t') && sql.includes("t.target_type = 'kubernetes'")) {
          assert.deepEqual(params, ['cluster-1']);
          return {
            rowCount: 1,
            rows: [
              {
                id: 'cluster-1',
                workspace_id: 'workspace-1',
                target_type: 'kubernetes',
                name: 'cluster-1',
                status: 'online',
                namespace_include: [],
                namespace_exclude: [],
                write_confirmation_required_override: null,
                created_at: '2026-05-10T00:00:00.000Z',
                updated_at: '2026-05-10T00:00:00.000Z'
              }
            ]
          };
        }
        return { rowCount: 1, rows: [] };
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    await upsertClusterSnapshot({
      clusterId: 'cluster-1',
      workspaceId: 'stale-workspace-from-caller',
      timestamp: '2026-05-10T00:00:00.000Z',
      data: {
        resources: {
          pods: [{ uid: 'pod-1', name: 'pod-1', namespace: 'default', phase: 'Pending' }]
        },
        metrics: {
          nodes: [
            {
              usage: {
                cpu: '1500m',
                memory: '2Gi'
              }
            }
          ]
        },
        events: []
      }
    });

    assert.equal(statements[0], 'BEGIN');
    const latestSnapshotIndex = statements.findIndex((sql) => sql.includes('INSERT INTO target_snapshots'));
    const metricHistoryIndex = statements.findIndex((sql) => sql.includes('INSERT INTO target_metric_history'));
    assert.notEqual(latestSnapshotIndex, -1);
    assert.notEqual(metricHistoryIndex, -1);
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_snapshot_history')));
    assert.equal(queryParams[latestSnapshotIndex][1], 'workspace-1');
    assert.equal(queryParams[metricHistoryIndex][1], 'workspace-1');
    assert.deepEqual(JSON.parse(String(queryParams[metricHistoryIndex][4])), {
      cpuCores: 1.5,
      memoryBytes: 2 * 1024 ** 3
    });
    assert(statements.some((sql) => sql.includes('DELETE FROM target_inventory_items')));
    assert(statements.some((sql) => sql.includes('DELETE FROM target_findings')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_inventory_items')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_findings')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_issues')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_issue_observations')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_snapshot_summaries')));
    assert.equal(statements.at(-1), 'COMMIT');
  });

  it('ignores older Kubernetes snapshots without replacing latest rows, writing metrics, or reconciling issues', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        if (sql.includes('FROM targets t') && sql.includes("t.target_type = 'kubernetes'")) {
          assert.deepEqual(params, ['cluster-1']);
          return {
            rowCount: 1,
            rows: [
              {
                id: 'cluster-1',
                workspace_id: 'workspace-1',
                target_type: 'kubernetes',
                name: 'cluster-1',
                status: 'online',
                namespace_include: [],
                namespace_exclude: [],
                write_confirmation_required_override: null,
                created_at: '2026-05-10T00:00:00.000Z',
                updated_at: '2026-05-10T00:00:00.000Z'
              }
            ]
          };
        }
        if (sql.includes('FROM target_snapshots')) {
          return {
            rowCount: 1,
            rows: [
              {
                target_id: 'cluster-1',
                workspace_id: 'workspace-1',
                snapshot_ts: '2026-05-10T00:05:00.000Z',
                data: { resources: { pods: [] }, events: [] }
              }
            ]
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    await upsertClusterSnapshot({
      clusterId: 'cluster-1',
      workspaceId: 'workspace-1',
      timestamp: '2026-05-10T00:04:00.000Z',
      data: {
        resources: {
          pods: [{ uid: 'pod-1', name: 'pod-1', namespace: 'default', phase: 'Pending' }]
        },
        events: []
      }
    });

    assert(!statements.some((sql) => sql.includes('INSERT INTO target_snapshot_history')));
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_metric_history')));
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_snapshots')));
    assert(!statements.some((sql) => sql.includes('DELETE FROM target_inventory_items')));
    assert(!statements.some((sql) => sql.includes('INSERT INTO target_issues')));
    assert.equal(statements.at(-1), 'COMMIT');
  });
});
