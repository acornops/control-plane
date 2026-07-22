import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  listClusterResources,
  listClusters
} from '../src/controllers/workspaces/kubernetes-cluster-controller.js';
import { repo } from '../src/store/repository.js';
import type { Cluster } from '../src/types/domain.js';

const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalGetCluster = repo.getCluster;
const originalListClusters = repo.listClusters;
const originalListClusterSnapshotResources = repo.listClusterSnapshotResources;
const originalListClusterSnapshotSummaries = repo.listClusterSnapshotSummaries;
const originalGetExternalIntegrationWorkspaceGrant = repo.getExternalIntegrationWorkspaceGrant;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getCluster = originalGetCluster;
  repo.listClusters = originalListClusters;
  repo.listClusterSnapshotResources = originalListClusterSnapshotResources;
  repo.listClusterSnapshotSummaries = originalListClusterSnapshotSummaries;
  repo.getExternalIntegrationWorkspaceGrant = originalGetExternalIntegrationWorkspaceGrant;
});

function createExternalIntegrationRequest() {
  return {
    auth: {
      userId: 'user-1',
      credential: {
        type: 'external_integration' as const,
        linkId: 'link-1',
        integrationId: 'external-chat',
        provider: 'external',
        externalUserId: 'external-user-1'
      }
    },
    params: {
      workspaceId: 'workspace-1',
      clusterId: 'cluster-1'
    },
    query: {}
  };
}

function installExternalIntegrationGrant(): void {
  repo.getExternalIntegrationWorkspaceGrant = async () => ({
    workspaceId: 'workspace-1',
    capabilities: ['read_workspace_data', 'create_sessions', 'create_read_only_runs'],
    grantedByUserId: 'user-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  });
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

describe('external integration normalized snapshot reads', () => {
  it('lists clusters through workspace data reads', async () => {
    installExternalIntegrationGrant();
    repo.getWorkspaceRole = async () => 'owner';
    repo.listClusters = async () => ({
      items: [createCluster()],
      nextCursor: undefined
    });
    repo.listClusterSnapshotSummaries = async () => new Map([
      [
        'cluster-1',
        {
          latestSnapshot: '2026-06-01T00:00:00.000Z',
          summary: {
            resourceCount: 3,
            findingCount: 1,
            criticalFindingCount: 0,
            namespaceCount: 1,
            nodeCount: 1,
            resourceFamilyCounts: {
              workloads: 2,
              network: 1,
              storage: 0,
              cluster: 0
            },
            resourceKindCounts: {
              Pod: 2,
              Service: 1
            }
          }
        }
      ]
    ]);
    const res = createResponse();

    await listClusters(createExternalIntegrationRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { items: Array<{ id: string; summary: { resourceCount: number } }> }).items, [
      {
        ...createCluster(),
        latestSnapshot: '2026-06-01T00:00:00.000Z',
        summary: {
          resourceCount: 3,
          findingCount: 1,
          criticalFindingCount: 0,
          namespaceCount: 1,
          nodeCount: 1,
          resourceFamilyCounts: {
            workloads: 2,
            network: 1,
            storage: 0,
            cluster: 0
          },
          resourceKindCounts: {
            Pod: 2,
            Service: 1
          }
        }
      }
    ]);
  });

  it('reads cluster resources', async () => {
    installExternalIntegrationGrant();
    repo.getWorkspaceRole = async () => 'owner';
    repo.getCluster = async () => createCluster();
    repo.listClusterSnapshotResources = async (clusterId) => ({
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
      nextCursor: undefined
    });
    const res = createResponse();

    await listClusterResources(createExternalIntegrationRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { items: Array<{ id: string }> }).items[0].id, 'pod-1');
  });

  it('rejects cluster lists when the linked role cannot read workspace data', async () => {
    installExternalIntegrationGrant();
    repo.getWorkspaceRole = async () => 'auditor';
    repo.listClusters = async () => {
      throw new Error('cluster list should not run without workspace data access');
    };
    const res = createResponse();

    await listClusters(createExternalIntegrationRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: { code: 'FORBIDDEN', message: 'No access to workspace data', retryable: false }
    });
  });
});
