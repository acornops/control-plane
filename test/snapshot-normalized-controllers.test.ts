import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listWorkspaceInvestigations } from '../src/controllers/workspaces-controller.js';
import {
  listClusterResources,
  listClusters
} from '../src/controllers/workspaces/kubernetes-cluster-controller.js';
import { repo } from '../src/store/repository.js';
import type { Cluster } from '../src/types/domain.js';
import { encodeCursor } from '../src/utils/pagination.js';

const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalGetCluster = repo.getCluster;
const originalGetClusterSnapshot = repo.getClusterSnapshot;
const originalListClusters = repo.listClusters;
const originalListClusterSnapshotResources = repo.listClusterSnapshotResources;
const originalListClusterSnapshotSummaries = repo.listClusterSnapshotSummaries;
const originalListWorkspaceSnapshotFindings = repo.listWorkspaceSnapshotFindings;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getCluster = originalGetCluster;
  repo.getClusterSnapshot = originalGetClusterSnapshot;
  repo.listClusters = originalListClusters;
  repo.listClusterSnapshotResources = originalListClusterSnapshotResources;
  repo.listClusterSnapshotSummaries = originalListClusterSnapshotSummaries;
  repo.listWorkspaceSnapshotFindings = originalListWorkspaceSnapshotFindings;
});

function createRequest(query: Record<string, string | undefined> = {}) {
  return {
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    },
    params: {
      workspaceId: 'workspace-1',
      clusterId: 'cluster-1'
    },
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

function createCluster(id = 'cluster-1'): Cluster {
  return {
    id,
    workspaceId: 'workspace-1',
    name: id,
    status: 'online',
    namespaceInclude: [],
    namespaceExclude: [],
    writeConfirmationPolicy: {
      effectiveRequired: false,
      overrideRequired: null,
      source: 'deployment_default'
    },
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z'
  };
}

describe('normalized snapshot controller reads', () => {
  it('lists cluster resources through normalized rows instead of raw snapshots', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getCluster = async () => createCluster();
    repo.getClusterSnapshot = async () => {
      throw new Error('raw snapshot should not be read');
    };
    repo.listClusterSnapshotResources = async (clusterId, options) => ({
      items: [
        {
          id: 'pod-1',
          family: 'workloads',
          kind: 'Pod',
          name: 'pod-1',
          namespace: 'default',
          status: 'Running',
          clusterId,
          clusterName: 'cluster-1',
          item: {}
        }
      ],
      nextCursor: options.signature
    });
    const res = createResponse();

    await listClusterResources(
      createRequest({ q: 'pod', family: 'workloads', health: 'healthy', limit: '25' }) as never,
      res as never,
      (err?: unknown) => {
        if (err) throw err;
      }
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { items: Array<{ id: string }> }).items.map((item) => item.id), ['pod-1']);
  });

  it('lists workspace investigations through normalized rows without scanning clusters', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.listClusters = async () => {
      throw new Error('workspace investigations should not scan clusters');
    };
    repo.getClusterSnapshot = async () => {
      throw new Error('workspace investigations should not read raw snapshots');
    };
    repo.listWorkspaceSnapshotFindings = async (_workspaceId, options) => ({
      items: [
        {
          id: 'finding-1',
          severity: 'critical',
          title: 'Pod unhealthy',
          message: 'Pod is unhealthy.',
          timestamp: Date.parse('2026-05-10T00:00:00.000Z'),
          clusterId: options.clusterId || 'cluster-1',
          clusterName: 'cluster-1'
        }
      ]
    });
    const res = createResponse();

    await listWorkspaceInvestigations(
      createRequest({ severity: 'critical', clusterId: 'cluster-1' }) as never,
      res as never,
      (err?: unknown) => {
        if (err) throw err;
      }
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { items: Array<{ id: string }> }).items.map((item) => item.id), ['finding-1']);
  });

  it('uses normalized summaries for cluster list payloads', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getClusterSnapshot = async () => {
      throw new Error('cluster list should not read raw snapshots');
    };
    repo.listClusters = async () => ({
      items: [createCluster()],
      nextCursor: undefined
    });
    repo.listClusterSnapshotSummaries = async () => new Map([
      [
        'cluster-1',
        {
          latestSnapshot: {
            clusterId: 'cluster-1',
            workspaceId: 'workspace-1',
            timestamp: '2026-05-10T00:00:00.000Z'
          },
          summary: {
            resourceCount: 7,
            findingCount: 2,
            criticalFindingCount: 1,
            namespaceCount: 3,
            nodeCount: 2,
            resourceFamilyCounts: {
              workloads: 4,
              network: 1,
              storage: 0,
              cluster: 2
            },
            resourceKindCounts: {
              Pod: 4,
              Node: 2,
              Service: 1
            }
          }
        }
      ]
    ]);
    const res = createResponse();

    await listClusters(createRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { items: Array<{ summary: { resourceCount: number } }> }).items[0].summary.resourceCount, 7);
  });

  it('rejects resource cursors with mismatched filter signatures before repository reads', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getCluster = async () => createCluster();
    repo.listClusterSnapshotResources = async () => {
      throw new Error('normalized resource read should not run for an invalid cursor');
    };
    const cursor = encodeCursor({ signature: '{"q":"different"}', sortKey: 'workloads:Pod:default:pod:pod-1' });
    const res = createResponse();

    await listClusterResources(createRequest({ q: 'pod', cursor }) as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual((res.body as { error: { code: string } }).error.code, 'INVALID_CURSOR');
  });
});
