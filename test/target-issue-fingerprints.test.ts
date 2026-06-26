import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveKubernetesIssueObservations } from '../src/services/target-issue-derivation.js';
import type { ClusterSnapshot, KubernetesCluster } from '../src/types/domain.js';
import type { SnapshotFindingListItem } from '../src/services/snapshot-derived-data.js';

function cluster(): KubernetesCluster {
  return {
    id: 'cluster-1',
    workspaceId: 'workspace-1',
    name: 'prod-cluster',
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

function snapshot(): ClusterSnapshot {
  return {
    clusterId: 'cluster-1',
    workspaceId: 'workspace-1',
    timestamp: '2026-05-10T00:00:00.000Z',
    data: {
      resources: { pods: [] },
      events: []
    }
  };
}

function finding(overrides: Partial<SnapshotFindingListItem>): SnapshotFindingListItem {
  return {
    id: 'finding-1',
    clusterId: 'cluster-1',
    clusterName: 'prod-cluster',
    severity: 'warning',
    title: 'Finding',
    message: 'Finding message.',
    timestamp: Date.parse('2026-05-10T00:00:00.000Z'),
    ...overrides
  };
}

describe('target issue fingerprints', () => {
  it('does not promote normal Kubernetes events into durable issues', () => {
    const observations = deriveKubernetesIssueObservations(
      cluster(),
      snapshot(),
      [
        finding({
          id: 'event-1',
          severity: 'info',
          title: 'Scheduled',
          message: 'Successfully assigned default/api to node-a.',
          namespace: 'default',
          objectKind: 'Pod',
          objectName: 'api',
          reason: 'Scheduled'
        }),
        finding({
          id: 'event-2',
          severity: 'info',
          title: 'Pulled',
          message: 'Container image is already present on machine.',
          namespace: 'default',
          objectKind: 'Pod',
          objectName: 'api',
          reason: 'Pulled'
        }),
        finding({
          id: 'event-3',
          severity: 'info',
          title: 'BackOff',
          message: 'Normal event text should not become a durable pod issue.',
          namespace: 'default',
          objectKind: 'Pod',
          objectName: 'api',
          reason: 'BackOff'
        })
      ]
    );

    assert.equal(observations.length, 0);
  });

  it('keeps fixed Kubernetes issue-class fingerprints stable where the durable issue rule requires it', () => {
    const first = deriveKubernetesIssueObservations(
      cluster(),
      snapshot(),
      [
        finding({
          id: 'node-1',
          severity: 'critical',
          title: 'Node node-a is not ready',
          message: 'Kubelet reports node-a as not ready.',
          objectKind: 'Node',
          objectName: 'node-a',
          reason: 'KubeletNotReady'
        }),
        finding({
          id: 'job-1',
          severity: 'warning',
          title: 'Job nightly failed',
          message: 'Job nightly exceeded the backoff limit.',
          namespace: 'batch',
          objectKind: 'Job',
          objectName: 'nightly',
          reason: 'BackoffLimitExceeded'
        }),
        finding({
          id: 'pvc-1',
          severity: 'warning',
          title: 'PVC data is unbound',
          message: 'PVC data is pending a volume.',
          namespace: 'default',
          objectKind: 'PersistentVolumeClaim',
          objectName: 'data',
          reason: 'Pending'
        })
      ]
    );
    const second = deriveKubernetesIssueObservations(
      cluster(),
      snapshot(),
      [
        finding({
          id: 'node-2',
          severity: 'critical',
          title: 'Node node-a is not ready',
          message: 'NetworkUnavailable also reports node-a as not ready.',
          objectKind: 'Node',
          objectName: 'node-a',
          reason: 'NetworkUnavailable',
          timestamp: Date.parse('2026-05-10T00:01:00.000Z')
        }),
        finding({
          id: 'job-2',
          severity: 'warning',
          title: 'Job nightly failed',
          message: 'Job nightly failed with a deadline exceeded condition.',
          namespace: 'batch',
          objectKind: 'Job',
          objectName: 'nightly',
          reason: 'DeadlineExceeded',
          timestamp: Date.parse('2026-05-10T00:01:00.000Z')
        }),
        finding({
          id: 'pvc-2',
          severity: 'warning',
          title: 'PVC data is lost',
          message: 'PVC data reports a lost volume.',
          namespace: 'default',
          objectKind: 'PersistentVolumeClaim',
          objectName: 'data',
          reason: 'Lost',
          timestamp: Date.parse('2026-05-10T00:01:00.000Z')
        })
      ]
    );

    const firstByKind = new Map(first.map((observation) => [observation.objectKind, observation]));
    const secondByKind = new Map(second.map((observation) => [observation.objectKind, observation]));

    assert.equal(firstByKind.get('Node')?.fingerprint, secondByKind.get('Node')?.fingerprint);
    assert.equal(firstByKind.get('Job')?.fingerprint, secondByKind.get('Job')?.fingerprint);
    assert.notEqual(firstByKind.get('PersistentVolumeClaim')?.fingerprint, secondByKind.get('PersistentVolumeClaim')?.fingerprint);
    assert.equal(firstByKind.get('Node')?.reason, 'KubeletNotReady');
    assert.equal(secondByKind.get('Job')?.reason, 'DeadlineExceeded');
  });
});
