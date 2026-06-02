import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveSnapshotRows, listSnapshotFindings, summarizeSnapshot } from '../src/services/snapshot-listing.js';
import { Cluster, ClusterSnapshot } from '../src/types/domain.js';

const cluster: Cluster = {
  id: 'cluster-1',
  workspaceId: 'workspace-1',
  name: 'demo-cluster',
  status: 'online',
  namespaceInclude: [],
  namespaceExclude: [],
  writeConfirmationPolicy: {
    effectiveRequired: false,
    overrideRequired: null,
    source: 'deployment_default'
  },
  createdAt: '2026-05-10T11:00:00.000Z',
  updatedAt: '2026-05-10T11:00:00.000Z'
};

describe('snapshot listing findings', () => {
  it('derives findings from unhealthy snapshot resource state when no Kubernetes event exists', () => {
    const snapshot: ClusterSnapshot = {
      clusterId: cluster.id,
      workspaceId: cluster.workspaceId,
      timestamp: '2026-05-10T12:00:00.000Z',
      data: {
        resources: {
          pods: [
            {
              name: 'demo-unhealthy-pod',
              namespace: 'default',
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  ready: false,
                  restartCount: 4,
                  state: {
                    waiting: {
                      reason: 'CrashLoopBackOff'
                    }
                  }
                }
              ]
            }
          ]
        },
        events: []
      }
    };

    const findings = listSnapshotFindings(cluster, snapshot);

    assert.deepEqual(findings, [
      {
        id: 'cluster-1:snapshot-pod-default-demo-unhealthy-pod',
        severity: 'critical',
        title: 'Pod demo-unhealthy-pod is unhealthy',
        message: 'Latest snapshot reports pod demo-unhealthy-pod in namespace default as CrashLoopBackOff. Restart count: 4.',
        timestamp: Date.parse('2026-05-10T12:00:00.000Z'),
        namespace: 'default',
        objectKind: 'Pod',
        objectName: 'demo-unhealthy-pod',
        reason: 'CrashLoopBackOff',
        clusterId: 'cluster-1',
        clusterName: 'demo-cluster'
      }
    ]);
  });

  it('summarizes resource and finding counts for bounded cluster list responses', () => {
    const snapshot: ClusterSnapshot = {
      clusterId: cluster.id,
      workspaceId: cluster.workspaceId,
      timestamp: '2026-05-10T12:00:00.000Z',
      data: {
        resources: {
          namespaces: [{ name: 'default', status: 'Active' }],
          nodes: [{ name: 'node-1', status: { conditions: [{ type: 'Ready', status: 'True' }] } }],
          pods: [
            {
              name: 'demo-unhealthy-pod',
              namespace: 'default',
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  ready: false,
                  state: {
                    waiting: {
                      reason: 'CrashLoopBackOff'
                    }
                  }
                }
              ]
            }
          ],
          services: [{ name: 'api', namespace: 'default' }]
        },
        events: []
      }
    };

    assert.deepEqual(summarizeSnapshot(cluster, snapshot), {
      resourceCount: 4,
      findingCount: 1,
      criticalFindingCount: 1,
      namespaceCount: 1,
      nodeCount: 1,
      resourceFamilyCounts: {
        workloads: 1,
        network: 1,
        storage: 0,
        cluster: 2
      },
      resourceKindCounts: {
        Namespace: 1,
        Node: 1,
        Pod: 1,
        Service: 1
      }
    });
  });

  it('builds normalized resource and finding rows for latest-snapshot indexes', () => {
    const snapshot: ClusterSnapshot = {
      clusterId: cluster.id,
      workspaceId: cluster.workspaceId,
      timestamp: '2026-05-10T12:00:00.000Z',
      data: {
        resources: {
          pods: [
            {
              uid: 'pod-uid-1',
              name: 'demo-pending-pod',
              namespace: 'default',
              phase: 'Pending',
              nodeName: 'node-1'
            }
          ]
        },
        events: []
      }
    };

    const derived = deriveSnapshotRows(cluster, snapshot);

    assert.deepEqual(derived.resources.map((row) => ({
      resourceId: row.resourceId,
      family: row.family,
      kind: row.kind,
      namespace: row.namespace,
      name: row.name,
      status: row.status,
      node: row.node,
      needsAttention: row.needsAttention,
      sortKey: row.sortKey,
      searchText: row.searchText
    })), [
      {
        resourceId: 'pod-uid-1',
        family: 'workloads',
        kind: 'Pod',
        namespace: 'default',
        name: 'demo-pending-pod',
        status: 'Pending',
        node: 'node-1',
        needsAttention: true,
        sortKey: 'workloads:Pod:default:demo-pending-pod:pod-uid-1',
        searchText: 'demo-pending-pod default pod pending node-1 demo-cluster'
      }
    ]);
    assert.deepEqual(derived.findings.map((row) => ({
      findingId: row.findingId,
      severity: row.severity,
      severityRank: row.severityRank,
      namespace: row.namespace,
      objectKind: row.objectKind,
      objectName: row.objectName,
      reason: row.reason,
      findingTs: row.findingTs
    })), [
      {
        findingId: 'cluster-1:snapshot-pod-default-demo-pending-pod',
        severity: 'warning',
        severityRank: 1,
        namespace: 'default',
        objectKind: 'Pod',
        objectName: 'demo-pending-pod',
        reason: 'Pending',
        findingTs: '2026-05-10T12:00:00.000Z'
      }
    ]);
    assert.equal(derived.summary.resourceCount, 1);
    assert.equal(derived.summary.findingCount, 1);
  });

  it('keeps critical snapshot findings ahead of warning events', () => {
    const snapshot: ClusterSnapshot = {
      clusterId: cluster.id,
      workspaceId: cluster.workspaceId,
      timestamp: '2026-05-10T12:00:00.000Z',
      data: {
        resources: {
          pods: [
            {
              name: 'demo-unhealthy-pod',
              namespace: 'default',
              phase: 'Failed'
            }
          ]
        },
        events: [
          {
            type: 'Warning',
            reason: 'Scheduled',
            message: 'A warning event that is less severe than the pod finding.',
            lastTimestamp: '2026-05-10T12:05:00.000Z',
            involvedObject: {
              kind: 'Pod',
              namespace: 'default',
              name: 'other-pod'
            }
          }
        ]
      }
    };

    const findings = listSnapshotFindings(cluster, snapshot);

    assert.equal(findings[0]?.id, 'cluster-1:snapshot-pod-default-demo-unhealthy-pod');
    assert.equal(findings[0]?.severity, 'critical');
    assert.equal(findings[1]?.severity, 'warning');
  });
});
