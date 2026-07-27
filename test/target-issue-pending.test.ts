import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listSnapshotFindings } from '../src/services/snapshot-derived-data.js';
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

function snapshot(input: {
  timestamp: string;
  creationTimestamp?: string;
  phase?: string;
  events?: Array<Record<string, unknown>>;
}): ClusterSnapshot {
  return {
    clusterId: 'cluster-1',
    workspaceId: 'workspace-1',
    timestamp: input.timestamp,
    data: {
      resources: {
        pods: [{
          name: 'api-7d9f6c94c6-r8dzx',
          namespace: 'default',
          phase: input.phase || 'Pending',
          creationTimestamp: input.creationTimestamp,
          ownerReferences: [{
            kind: 'ReplicaSet',
            name: 'api-7d9f6c94c6',
            controller: true
          }],
          containerStatuses: []
        }]
      },
      events: input.events || []
    }
  };
}

function observations(value: ClusterSnapshot) {
  return deriveKubernetesIssueObservations(
    cluster(),
    value,
    listSnapshotFindings(cluster(), value)
  );
}

describe('pending pod issue qualification', () => {
  it('keeps short-lived pending pods as findings without creating Target Issues', () => {
    const value = snapshot({
      timestamp: '2026-05-10T00:01:00.000Z',
      creationTimestamp: '2026-05-10T00:00:30.000Z'
    });

    assert.equal(listSnapshotFindings(cluster(), value).length, 1);
    assert.equal(observations(value).length, 0);
  });

  it('promotes a pod when it reaches the qualification threshold', () => {
    const value = snapshot({
      timestamp: '2026-05-10T00:02:30.000Z',
      creationTimestamp: '2026-05-10T00:00:30.000Z'
    });

    const [issue] = observations(value);

    assert.equal(issue.issueType, 'kubernetes_pod_pending');
    assert.equal(issue.objectKind, 'Deployment');
    assert.equal(issue.objectName, 'api');
    assert.equal(issue.reason, 'Pending');
    assert.equal(issue.evidence.pendingAgeMs, 120_000);
    assert.equal(issue.evidence.pendingIssueMinAgeMs, 120_000);
  });

  it('does not promote a pod immediately before the qualification threshold', () => {
    const value = snapshot({
      timestamp: '2026-05-10T00:02:29.999Z',
      creationTimestamp: '2026-05-10T00:00:30.000Z'
    });

    assert.equal(observations(value).length, 0);
  });

  it('does not promote ordinary pending state when pod age is unavailable', () => {
    const value = snapshot({
      timestamp: '2026-05-10T00:03:00.000Z'
    });

    assert.equal(observations(value).length, 0);
  });

  it('does not promote ordinary pending state when timestamps are invalid or clock-skewed', () => {
    assert.equal(observations(snapshot({
      timestamp: 'invalid',
      creationTimestamp: '2026-05-10T00:00:30.000Z'
    })).length, 0);
    assert.equal(observations(snapshot({
      timestamp: '2026-05-10T00:00:00.000Z',
      creationTimestamp: '2026-05-10T00:00:30.000Z'
    })).length, 0);
  });

  for (const reason of ['FailedScheduling', 'Unschedulable']) {
    it(`promotes actionable ${reason} findings immediately`, () => {
      const value = snapshot({
        timestamp: '2026-05-10T00:01:00.000Z',
        creationTimestamp: '2026-05-10T00:00:30.000Z',
        events: [{
          type: 'Warning',
          reason,
          message: `${reason} prevents this pod from being placed.`,
          lastTimestamp: '2026-05-10T00:01:00.000Z',
          involvedObject: {
            kind: 'Pod',
            namespace: 'default',
            name: 'api-7d9f6c94c6-r8dzx'
          }
        }]
      });

      const [issue] = observations(value);

      assert.equal(issue.issueType, 'kubernetes_pod_pending');
      assert.equal(issue.reason, reason);
    });
  }

  it('does not promote a recent scheduling event after the pod is running', () => {
    const value = snapshot({
      timestamp: '2026-05-10T00:01:00.000Z',
      creationTimestamp: '2026-05-10T00:00:30.000Z',
      phase: 'Running',
      events: [{
        type: 'Warning',
        reason: 'FailedScheduling',
        message: 'The pod was briefly unschedulable.',
        lastTimestamp: '2026-05-10T00:00:45.000Z',
        involvedObject: {
          kind: 'Pod',
          namespace: 'default',
          name: 'api-7d9f6c94c6-r8dzx'
        }
      }]
    });

    assert.equal(listSnapshotFindings(cluster(), value).length, 1);
    assert.equal(observations(value).length, 0);
  });
});
