import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  getTargetIssueSummary,
  listTargetIssueObservations,
  listWorkspaceIssues
} from '../src/controllers/workspaces-controller.js';
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
const originalListWorkspaceIssues = repo.listWorkspaceIssues;
const originalSummarizeTargetIssues = repo.summarizeTargetIssues;
const originalGetTargetIssue = repo.getTargetIssue;
const originalListTargetIssueObservations = repo.listTargetIssueObservations;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getCluster = originalGetCluster;
  repo.getClusterSnapshot = originalGetClusterSnapshot;
  repo.listClusters = originalListClusters;
  repo.listClusterSnapshotResources = originalListClusterSnapshotResources;
  repo.listClusterSnapshotSummaries = originalListClusterSnapshotSummaries;
  repo.listWorkspaceIssues = originalListWorkspaceIssues;
  repo.summarizeTargetIssues = originalSummarizeTargetIssues;
  repo.getTargetIssue = originalGetTargetIssue;
  repo.listTargetIssueObservations = originalListTargetIssueObservations;
});

function createRequest(query: Record<string, string | undefined> = {}) {
  return {
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    },
    params: {
      workspaceId: 'workspace-1',
      clusterId: 'cluster-1',
      targetId: 'cluster-1',
      issueId: 'issue-1'
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
    repo.getCluster = async () => ({
      ...createCluster(),
      namespaceInclude: ['payments'],
      namespaceExclude: ['sandbox']
    });
    repo.getClusterSnapshot = async () => {
      throw new Error('raw snapshot should not be read');
    };
    repo.listClusterSnapshotResources = async (clusterId, options) => {
      assert.deepEqual(options.namespaceInclude, ['payments']);
      assert.deepEqual(options.namespaceExclude, ['sandbox']);
      return {
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
      };
    };
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

  it('lists workspace issues through durable issue rows without scanning clusters', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.listClusters = async () => {
      throw new Error('workspace issues should not scan clusters');
    };
    repo.getClusterSnapshot = async () => {
      throw new Error('workspace issues should not read raw snapshots');
    };
    repo.listWorkspaceIssues = async (_workspaceId, options) => ({
      items: [
        {
          id: 'issue-1',
          workspaceId: 'workspace-1',
          targetId: options.targetId || 'cluster-1',
          targetType: 'kubernetes',
          targetName: 'cluster-1',
          fingerprint: 'kubernetes|cluster-1|default|deployment|api|app|pod-unhealthy',
          issueType: 'kubernetes_pod_unhealthy',
          status: 'active',
          severity: 'critical',
          title: 'Pod unhealthy',
          summary: 'Pod is unhealthy.',
          namespace: 'default',
          scopeKind: 'Namespace',
          scopeName: 'default',
          objectKind: 'Deployment',
          objectName: 'api',
          reason: 'CrashLoopBackOff',
          firstSeenAt: '2026-05-10T00:00:00.000Z',
          lastSeenAt: '2026-05-10T00:00:00.000Z',
          lastObservedSnapshotAt: '2026-05-10T00:00:00.000Z',
          occurrenceCount: 1,
          reopenedCount: 0,
          cleanSnapshotCount: 0,
          latestEvidence: {},
          createdAt: '2026-05-10T00:00:00.000Z',
          updatedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    });
    const res = createResponse();

    await listWorkspaceIssues(
      createRequest({ severity: 'critical', targetId: 'cluster-1' }) as never,
      res as never,
      (err?: unknown) => {
        if (err) throw err;
      }
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { items: Array<{ id: string }> }).items.map((item) => item.id), ['issue-1']);
  });

  it('returns target issue summary through durable issue rows', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getClusterSnapshot = async () => {
      throw new Error('target issue summary should not read raw snapshots');
    };
    repo.summarizeTargetIssues = async (workspaceId, targetId) => {
      assert.equal(workspaceId, 'workspace-1');
      assert.equal(targetId, 'cluster-1');
      return {
        total: 3,
        active: 2,
        recovering: 1,
        critical: 1,
        warning: 2,
        info: 0
      };
    };
    const res = createResponse();

    await getTargetIssueSummary(
      createRequest() as never,
      res as never,
      (err?: unknown) => {
        if (err) throw err;
      }
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      total: 3,
      active: 2,
      recovering: 1,
      critical: 1,
      warning: 2,
      info: 0
    });
  });

  it('returns not found for missing issue observation history', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getTargetIssue = async () => null;
    repo.listTargetIssueObservations = async () => {
      throw new Error('missing issue should be checked before observations');
    };
    const res = createResponse();

    await listTargetIssueObservations(
      createRequest() as never,
      res as never,
      (err?: unknown) => {
        if (err) throw err;
      }
    );

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: { code: 'NOT_FOUND', message: 'Issue not found', retryable: false } });
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
