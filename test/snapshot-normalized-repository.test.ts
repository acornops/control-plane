import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  upsertClusterSnapshot
} from '../src/store/repository-kubernetes-clusters.js';
import {
  listClusterSnapshotResources,
  listWorkspaceSnapshotFindings
} from '../src/store/repository-kubernetes-inventory.js';
import { decodeCursor } from '../src/utils/pagination.js';

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

  it('uses severity-first keyset pagination for workspace findings', async () => {
    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      assert.match(sql, /FROM target_findings f/);
      assert.match(sql, /f\.workspace_id = \$1/);
      assert.match(sql, /f\.severity = \$2/);
      assert.match(sql, /f\.target_id = \$3/);
      assert.match(sql, /f\.severity_rank > \$4/);
      assert.match(sql, /ORDER BY f\.severity_rank ASC, f\.finding_ts DESC, f\.finding_id ASC/);
      assert.deepEqual(params, [
        'workspace-1',
        'critical',
        'cluster-1',
        0,
        '2026-05-10T00:00:00.000Z',
        'finding-0',
        2
      ]);
      return {
        rows: [
          {
            finding_id: 'finding-1',
            severity: 'critical',
            severity_rank: 0,
            title: 'Pod unhealthy',
            message: 'Pod is unhealthy.',
            finding_ts: '2026-05-10T00:00:00.000Z',
            namespace: 'default',
            object_kind: 'Pod',
            object_name: 'pod-1',
            reason: 'CrashLoopBackOff',
            cluster_id: 'cluster-1',
            cluster_name: 'cluster-1'
          },
          {
            finding_id: 'finding-2',
            severity: 'critical',
            severity_rank: 0,
            title: 'Node unhealthy',
            message: 'Node is unhealthy.',
            finding_ts: '2026-05-09T00:00:00.000Z',
            namespace: null,
            object_kind: 'Node',
            object_name: 'node-1',
            reason: 'NotReady',
            cluster_id: 'cluster-1',
            cluster_name: 'cluster-1'
          }
        ]
      };
    });

    const page = await listWorkspaceSnapshotFindings('workspace-1', {
      limit: 1,
      cursor: {
        severityRank: 0,
        findingTs: '2026-05-10T00:00:00.000Z',
        findingId: 'finding-0'
      },
      severity: 'critical',
      clusterId: 'cluster-1',
      signature: 'sig'
    });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, 'finding-1');
    assert.deepEqual(decodeCursor(page.nextCursor, 'sig'), {
      signature: 'sig',
      severityRank: 0,
      findingTs: '2026-05-10T00:00:00.000Z',
      findingId: 'finding-1'
    });
  });

  it('matches workspace findings search against current joined cluster names', async () => {
    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      assert.match(sql, /f\.search_text LIKE \$2/);
      assert.match(sql, /LOWER\(t\.name\) LIKE \$2/);
      assert.deepEqual(params, ['workspace-1', '%renamed\\_cluster%', 2]);
      return { rows: [] };
    });

    const page = await listWorkspaceSnapshotFindings('workspace-1', {
      limit: 1,
      q: 'Renamed_Cluster'
    });

    assert.deepEqual(page, { items: [], nextCursor: undefined });
  });
});

describe('normalized snapshot repository ingest', () => {
  it('writes raw snapshot history and replaces normalized latest rows in one transaction', async () => {
    const statements: string[] = [];
    const queryParams: unknown[][] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        queryParams.push(params ?? []);
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
        events: []
      }
    });

    assert.equal(statements[0], 'BEGIN');
    const latestSnapshotIndex = statements.findIndex((sql) => sql.includes('INSERT INTO target_snapshots'));
    const historySnapshotIndex = statements.findIndex((sql) => sql.includes('INSERT INTO target_snapshot_history'));
    assert.notEqual(latestSnapshotIndex, -1);
    assert.notEqual(historySnapshotIndex, -1);
    assert.equal(queryParams[latestSnapshotIndex][1], 'workspace-1');
    assert.equal(queryParams[historySnapshotIndex][2], 'workspace-1');
    assert(statements.some((sql) => sql.includes('DELETE FROM target_inventory_items')));
    assert(statements.some((sql) => sql.includes('DELETE FROM target_findings')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_inventory_items')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_findings')));
    assert(statements.some((sql) => sql.includes('INSERT INTO target_snapshot_summaries')));
    assert.equal(statements.at(-1), 'COMMIT');
  });
});
