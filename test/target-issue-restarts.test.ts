import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveKubernetesIssueObservations } from '../src/services/target-issue-derivation.js';
import type { ClusterSnapshot, KubernetesCluster } from '../src/types/domain.js';

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

function pod(name: string, restartCount: number): Record<string, unknown> {
  return podWithContainers(name, [{ name: 'api', restartCount }]);
}

function podWithContainers(name: string, containerStatuses: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    name,
    namespace: 'default',
    ownerReferences: [
      {
        kind: 'ReplicaSet',
        name: 'api-7d9f6c94c6',
        controller: true
      }
    ],
    containerStatuses
  };
}

function snapshot(pods: Record<string, unknown>[]): ClusterSnapshot {
  return {
    clusterId: 'cluster-1',
    workspaceId: 'workspace-1',
    timestamp: '2026-05-10T00:00:00.000Z',
    data: {
      resources: { pods },
      events: []
    }
  };
}

describe('target issue restart derivation', () => {
  it('does not turn historical restart counters into issues without new evidence', () => {
    const firstObserved = deriveKubernetesIssueObservations(cluster(), snapshot([pod('api-7d9f6c94c6-r8dzx', 312)]), []);
    const unchanged = deriveKubernetesIssueObservations(
      cluster(),
      snapshot([pod('api-7d9f6c94c6-r8dzx', 312)]),
      [],
      snapshot([pod('api-7d9f6c94c6-r8dzx', 312)])
    );

    assert.equal(firstObserved.length, 0);
    assert.equal(unchanged.length, 0);
  });

  it('uses workload owner fingerprints and keeps high-restart issues stable through pod churn', () => {
    const first = deriveKubernetesIssueObservations(
      cluster(),
      snapshot([pod('api-7d9f6c94c6-r8dzx', 312)]),
      [],
      snapshot([pod('api-7d9f6c94c6-r8dzx', 311)])
    );
    const second = deriveKubernetesIssueObservations(
      cluster(),
      snapshot([pod('api-7d9f6c94c6-z9abc', 320)]),
      [],
      snapshot([pod('api-7d9f6c94c6-r8dzx', 0)])
    );

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].fingerprint, second[0].fingerprint);
    assert.equal(first[0].objectKind, 'Deployment');
    assert.equal(first[0].objectName, 'api');
    assert.equal(first[0].severity, 'critical');
    assert.equal(first[0].reason, 'HighRestartCount');
    assert.deepEqual(first[0].evidence.restartDelta, 1);
  });

  it('does not turn first-seen high restart counters into issues when no previous pod identity matches', () => {
    const observations = deriveKubernetesIssueObservations(
      cluster(),
      snapshot([pod('api-7d9f6c94c6-r8dzx', 312)]),
      [],
      snapshot([])
    );

    assert.equal(observations.length, 0);
  });

  it('matches previous workload identity by owner and current container name', () => {
    const observations = deriveKubernetesIssueObservations(
      cluster(),
      snapshot([
        podWithContainers('api-7d9f6c94c6-z9abc', [
          { name: 'api', restartCount: 12 },
          { name: 'sidecar', restartCount: 0 }
        ])
      ]),
      [],
      snapshot([
        podWithContainers('api-7d9f6c94c6-r8dzx', [
          { name: 'sidecar', restartCount: 0 },
          { name: 'api', restartCount: 0 }
        ])
      ])
    );

    assert.equal(observations.length, 1);
    assert.equal(observations[0].evidence.containerName, 'api');
    assert.equal(observations[0].evidence.restartDelta, 12);
  });
});
