import assert from 'node:assert/strict';
import { describe, it, mock, afterEach } from 'node:test';
import { db } from '../src/infra/db.js';
import { deriveVirtualMachineIssueObservations } from '../src/services/target-issue-derivation.js';
import {
  listWorkspaceIssues,
  reconcileTargetIssues
} from '../src/store/repository-target-issues.js';
import { decodeCursor } from '../src/utils/pagination.js';
import type { VirtualMachineSnapshot, VirtualMachineTarget } from '../src/types/domain.js';

afterEach(() => {
  mock.restoreAll();
});

function virtualMachine(): VirtualMachineTarget {
  return {
    id: 'vm-1',
    workspaceId: 'workspace-1',
    name: 'prod-vm',
    hostname: 'prod-vm.local',
    status: 'online',
    osFamily: 'linux',
    serviceManager: 'systemd',
    allowedLogSources: ['journald'],
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z'
  };
}

function vmSnapshot(data: Partial<VirtualMachineSnapshot['data']> = {}): VirtualMachineSnapshot {
  return {
    targetId: 'vm-1',
    workspaceId: 'workspace-1',
    timestamp: '2026-05-10T00:00:00.000Z',
    data
  };
}

describe('target issue derivation', () => {
  it('keeps VM issue derivation problem-only and merges service evidence into one fingerprint', () => {
    const observations = deriveVirtualMachineIssueObservations(
      virtualMachine(),
      vmSnapshot({
        services: [
          { name: 'backup.service', loadState: 'loaded', activeState: 'failed', subState: 'failed' },
          { name: 'stopped.service', loadState: 'loaded', activeState: 'inactive', subState: 'dead' }
        ],
        findings: [
          {
            id: 'service-backup.service',
            severity: 'warning',
            title: 'Service backup.service is failed',
            message: 'backup.service state is failed/failed.',
            reason: 'failed',
            objectKind: 'systemd_service',
            objectName: 'backup.service',
            timestamp: '2026-05-10T00:00:00.000Z'
          },
          {
            id: 'service-stopped.service',
            severity: 'info',
            title: 'Service stopped.service is inactive',
            message: 'stopped.service state is inactive/dead.',
            reason: 'inactive',
            objectKind: 'systemd_service',
            objectName: 'stopped.service',
            timestamp: '2026-05-10T00:00:00.000Z'
          },
          {
            id: 'vm-healthy',
            severity: 'info',
            title: 'VM telemetry is healthy',
            message: 'No pressure or failed service findings were detected.',
            reason: 'healthy',
            objectKind: 'host',
            objectName: 'prod-vm.local',
            timestamp: '2026-05-10T00:00:00.000Z'
          }
        ]
      })
    );

    assert.equal(observations.length, 2);
    assert.equal(new Set(observations.map((observation) => observation.fingerprint)).size, 1);
    assert(observations.every((observation) => observation.objectName === 'backup.service'));
    assert(observations.every((observation) => observation.issueType === 'vm_service_unhealthy'));
  });

  it('treats VM failed service state casing as critical', () => {
    const observations = deriveVirtualMachineIssueObservations(
      virtualMachine(),
      vmSnapshot({
        services: [
          { name: 'api.service', loadState: 'loaded', activeState: 'Failed', subState: 'Failed' }
        ]
      })
    );

    assert.equal(observations.length, 1);
    assert.equal(observations[0].severity, 'critical');
    assert.equal(observations[0].reason, 'Failed');
  });
});

describe('target issue reconciliation', () => {
  it('updates one durable issue, marks it recovering, resolves after grace, then reopens it', async () => {
    const statements: string[] = [];
    const updates: Array<{ status: string; cleanSnapshotCount: number }> = [];
    let upsertCount = 0;
    let currentIssue = {
      id: 'issue-1',
      fingerprint: 'fp-1',
      last_seen_at: '2026-05-10T00:00:00.000Z',
      clean_snapshot_count: 0
    };
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        if (sql.includes('INSERT INTO target_issues') && sql.includes('RETURNING id')) {
          upsertCount += 1;
          return { rowCount: 1, rows: [{ id: 'issue-1' }] };
        }
        if (sql.includes('FROM target_issues')) {
          return { rowCount: 1, rows: [currentIssue] };
        }
        if (sql.includes('UPDATE target_issues')) {
          updates.push({ status: String(params?.[1]), cleanSnapshotCount: Number(params?.[2]) });
          currentIssue = {
            ...currentIssue,
            clean_snapshot_count: Number(params?.[2])
          };
        }
        return { rowCount: 1, rows: [] };
      }
    };
    const observation = {
      targetId: 'cluster-1',
      workspaceId: 'workspace-1',
      targetType: 'kubernetes' as const,
      snapshotTs: '2026-05-10T00:00:00.000Z',
      fingerprint: 'fp-1',
      issueType: 'kubernetes_pod_unhealthy',
      severity: 'critical' as const,
      title: 'Pod unhealthy',
      summary: 'Pod is unhealthy.',
      message: 'Pod is unhealthy.',
      scopeKind: 'Namespace',
      scopeName: 'default',
      objectKind: 'Deployment',
      objectName: 'api',
      reason: 'CrashLoopBackOff',
      findingId: 'finding-1',
      evidence: {},
      searchText: 'pod unhealthy api'
    };

    await reconcileTargetIssues(client, {
      targetId: 'cluster-1',
      snapshotTs: '2026-05-10T00:00:00.000Z',
      observations: [observation, { ...observation, findingId: 'event-1', message: 'Back-off restarting failed container' }]
    });
    await reconcileTargetIssues(client, {
      targetId: 'cluster-1',
      snapshotTs: '2026-05-10T00:01:00.000Z',
      observations: []
    });
    await reconcileTargetIssues(client, {
      targetId: 'cluster-1',
      snapshotTs: '2026-05-10T00:02:00.000Z',
      observations: []
    });
    await reconcileTargetIssues(client, {
      targetId: 'cluster-1',
      snapshotTs: '2026-05-10T00:03:00.000Z',
      observations: []
    });
    await reconcileTargetIssues(client, {
      targetId: 'cluster-1',
      snapshotTs: '2026-05-10T00:04:00.000Z',
      observations: [observation]
    });

    assert.equal(upsertCount, 2);
    assert.equal(statements.filter((sql) => sql.includes('INSERT INTO target_issue_observations')).length, 3);
    assert.deepEqual(updates, [
      { status: 'recovering', cleanSnapshotCount: 1 },
      { status: 'recovering', cleanSnapshotCount: 2 },
      { status: 'resolved', cleanSnapshotCount: 3 }
    ]);
  });

  it('filters and paginates workspace issues through SQL', async () => {
    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      assert.match(sql, /FROM target_issues i/);
      assert.match(sql, /i\.workspace_id = \$1/);
      assert.match(sql, /i\.status = \$2/);
      assert.match(sql, /i\.severity = \$3/);
      assert.match(sql, /i\.target_type = \$4/);
      assert.match(sql, /i\.target_id = \$5/);
      assert.match(sql, /i\.scope_name = \$6/);
      assert.match(sql, /i\.search_text LIKE \$7 ESCAPE '\\'/);
      assert.match(sql, /CASE i\.status WHEN 'active' THEN 0 WHEN 'recovering' THEN 1 ELSE 2 END > \$8/);
      assert.deepEqual(params, [
        'workspace-1',
        'active',
        'critical',
        'kubernetes',
        'cluster-1',
        'default',
        '%api\\_\\%%',
        0,
        0,
        '2026-05-10T00:00:00.000Z',
        'issue-0',
        2
      ]);
      return {
        rows: [
          {
            id: 'issue-1',
            workspace_id: 'workspace-1',
            target_id: 'cluster-1',
            target_type: 'kubernetes',
            target_name: 'prod-cluster',
            fingerprint: 'fp-1',
            issue_type: 'kubernetes_pod_unhealthy',
            status: 'active',
            severity: 'critical',
            severity_rank: 0,
            title: 'Pod unhealthy',
            summary: 'Pod is unhealthy.',
            scope_kind: 'Namespace',
            scope_name: 'default',
            object_kind: 'Deployment',
            object_name: 'api',
            reason: 'CrashLoopBackOff',
            first_seen_at: '2026-05-10T00:00:00.000Z',
            last_seen_at: '2026-05-10T00:00:00.000Z',
            last_observed_snapshot_at: '2026-05-10T00:00:00.000Z',
            resolved_at: null,
            occurrence_count: 2,
            reopened_count: 0,
            clean_snapshot_count: 0,
            latest_evidence: {},
            created_at: '2026-05-10T00:00:00.000Z',
            updated_at: '2026-05-10T00:00:00.000Z'
          },
          {
            id: 'issue-2',
            workspace_id: 'workspace-1',
            target_id: 'cluster-1',
            target_type: 'kubernetes',
            target_name: 'prod-cluster',
            fingerprint: 'fp-2',
            issue_type: 'kubernetes_pod_pending',
            status: 'active',
            severity: 'critical',
            severity_rank: 0,
            title: 'Pod pending',
            summary: 'Pod is pending.',
            scope_kind: 'Namespace',
            scope_name: 'default',
            object_kind: 'Deployment',
            object_name: 'worker',
            reason: 'Unschedulable',
            first_seen_at: '2026-05-09T00:00:00.000Z',
            last_seen_at: '2026-05-09T00:00:00.000Z',
            last_observed_snapshot_at: '2026-05-09T00:00:00.000Z',
            resolved_at: null,
            occurrence_count: 1,
            reopened_count: 0,
            clean_snapshot_count: 0,
            latest_evidence: {},
            created_at: '2026-05-09T00:00:00.000Z',
            updated_at: '2026-05-09T00:00:00.000Z'
          }
        ]
      };
    });

    const page = await listWorkspaceIssues('workspace-1', {
      limit: 1,
      status: 'active',
      severity: 'critical',
      targetType: 'kubernetes',
      targetId: 'cluster-1',
      namespace: 'default',
      q: 'api_%',
      cursor: {
        statusRank: 0,
        severityRank: 0,
        lastSeenAt: '2026-05-10T00:00:00.000Z',
        issueId: 'issue-0'
      },
      signature: 'sig'
    });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, 'issue-1');
    assert.deepEqual(decodeCursor(page.nextCursor, 'sig'), {
      signature: 'sig',
      statusRank: 0,
      severityRank: 0,
      lastSeenAt: '2026-05-10T00:00:00.000Z',
      issueId: 'issue-1'
    });
  });
});
