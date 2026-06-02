import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { getWorkspaceClusterMetricsHistory } from '../src/controllers/workspaces/kubernetes-cluster-controller.js';
import { repo } from '../src/store/repository.js';
import type { Cluster, ClusterSnapshot } from '../src/types/domain.js';

const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalGetCluster = repo.getCluster;
const originalListClusterSnapshotHistory = repo.listClusterSnapshotHistory;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getCluster = originalGetCluster;
  repo.listClusterSnapshotHistory = originalListClusterSnapshotHistory;
  mock.reset();
});

function createRequest(query: Record<string, string | undefined>, workspaceId = 'workspace-1') {
  return {
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    },
    params: { workspaceId },
    query
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

function createCluster(id: string, workspaceId = 'workspace-1'): Cluster {
  return {
    id,
    workspaceId,
    name: id,
    status: 'online',
    namespaceInclude: [],
    namespaceExclude: [],
    writeConfirmationPolicy: {
      effectiveRequired: false,
      overrideRequired: null,
      source: 'deployment_default'
    },
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z'
  };
}

function createSnapshot(clusterId: string, workspaceId = 'workspace-1'): ClusterSnapshot {
  return {
    clusterId,
    workspaceId,
    timestamp: '2026-05-25T00:00:00.000Z',
    data: {
      metrics: {
        nodes: [
          {
            usage: {
              cpu: '1500m',
              memory: '2Gi'
            }
          }
        ]
      }
    }
  };
}

describe('workspace cluster metrics history', () => {
  it('rejects users without workspace access', async () => {
    repo.getWorkspaceRole = async () => null;
    const res = createResponse();

    await getWorkspaceClusterMetricsHistory(createRequest({ clusterIds: 'cluster-1' }) as never, res as never, () => undefined);

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: {
        code: 'FORBIDDEN',
        message: 'No access to workspace data',
        retryable: false
      }
    });
  });

  it('returns an empty item list when no cluster IDs are requested', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    const res = createResponse();

    await getWorkspaceClusterMetricsHistory(createRequest({}) as never, res as never, () => undefined);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      workspaceId: 'workspace-1',
      windowMs: 60 * 60 * 1000,
      items: []
    });
  });

  it('caps requested cluster IDs, skips missing and cross-workspace clusters, and groups points', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    const requestedClusterIds = [
      'cluster-1',
      'cluster-1',
      'missing',
      'other-workspace',
      ...Array.from({ length: 25 }, (_unused, index) => `extra-${index}`)
    ];
    const getClusterCalls: string[] = [];
    const historyCalls: string[] = [];
    repo.getCluster = async (clusterId: string) => {
      getClusterCalls.push(clusterId);
      if (clusterId === 'missing') return null;
      if (clusterId === 'other-workspace') return createCluster(clusterId, 'workspace-2');
      return createCluster(clusterId);
    };
    repo.listClusterSnapshotHistory = async (clusterId: string) => {
      historyCalls.push(clusterId);
      return [
        createSnapshot(clusterId),
        createSnapshot(clusterId, 'workspace-2')
      ];
    };
    const res = createResponse();

    await getWorkspaceClusterMetricsHistory(
      createRequest({ clusterIds: requestedClusterIds.join(','), window: '6h', limit: '24' }) as never,
      res as never,
      () => undefined
    );

    assert.equal(res.statusCode, 200);
    assert.equal(getClusterCalls.length, 20);
    assert.equal(new Set(getClusterCalls).size, 20);
    assert.equal(historyCalls.includes('missing'), false);
    assert.equal(historyCalls.includes('other-workspace'), false);
    assert.deepEqual((res.body as { items: Array<{ clusterId: string }> }).items.map((item) => item.clusterId), historyCalls);
    assert.deepEqual((res.body as { items: Array<{ points: unknown[] }> }).items[0].points, [
      {
        timestamp: '2026-05-25T00:00:00.000Z',
        cpuCores: 1.5,
        memoryBytes: 2 * 1024 ** 3
      }
    ]);
  });
});
