import assert from 'node:assert/strict';
import { after, beforeEach, it } from 'node:test';
import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { reconcileTargetIssues } from '../src/store/repository-target-issues.js';
import { withTransaction } from '../src/store/repository-transaction.js';
import type { TargetIssueObservationInput } from '../src/services/target-issue-derivation.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);

function observation(overrides: Partial<TargetIssueObservationInput> = {}): TargetIssueObservationInput {
  return {
    targetId: 'cluster-1', workspaceId: 'workspace-1', targetType: 'kubernetes',
    snapshotTs: '2026-10-01T00:00:00Z', fingerprint: 'persistent-issue',
    issueType: 'kubernetes_pod_unhealthy', severity: 'warning',
    title: 'Pod unhealthy', summary: 'Restart count: 1', message: 'Restart count: 1',
    scopeKind: 'Namespace', scopeName: 'default', objectKind: 'Deployment', objectName: 'api',
    reason: 'CrashLoopBackOff', findingId: 'finding-1',
    evidence: { source: 'snapshot_finding', podName: 'api-1', containerName: 'api', restartCount: 1 },
    searchText: 'pod unhealthy api', ...overrides
  };
}

async function ingest(observations: TargetIssueObservationInput[], snapshotTs = observations[0]?.snapshotTs || '2026-10-01T00:10:00Z') {
  const targetId = observations[0]?.targetId || 'cluster-1';
  await withTransaction(async client => {
    // Matches snapshot ingestion's per-target serialization.
    await client.query('SELECT id FROM targets WHERE id=$1 FOR UPDATE', [targetId]);
    await reconcileTargetIssues(client, { targetId, snapshotTs, observations });
  });
}

async function history() {
  return (await db.query('SELECT * FROM target_issue_observations ORDER BY created_at,id')).rows;
}

it('samples unchanged issues while refreshing current evidence and occurrence counts', async () => {
  await ingest([observation()]);
  for (let minute = 1; minute <= 60; minute++) {
    await ingest([observation({
      snapshotTs: new Date(Date.parse('2026-10-01T00:00:00Z') + minute * 60_000).toISOString(),
      findingId: `finding-${minute}`, summary: `Restart count: ${minute}`, message: `Restart count: ${minute}`,
      evidence: { source: 'snapshot_finding', podName: 'api-1', containerName: 'api', restartCount: minute, pendingAgeMs: minute * 60_000 }
    })]);
  }
  assert.equal((await history()).length, 1);
  const issue = (await db.query('SELECT * FROM target_issues')).rows[0];
  assert.equal(issue.occurrence_count, 61);
  assert.equal(issue.latest_evidence.restartCount, 60);
  assert.equal(new Date(issue.last_seen_at).toISOString(), '2026-10-01T01:00:00.000Z');
});

it('retains distinct sources and ignores input order and duplicate sources when sampling', async () => {
  const first = observation();
  const second = observation({ findingId: 'event-1', evidence: { source: 'kubernetes_event', podName: 'api-1' } });
  await ingest([first, second]);
  assert.equal((await history()).length, 2);
  await ingest([second, first, first]);
  assert.equal((await history()).length, 2);
  await ingest([first, second, observation({ evidence: { source: 'snapshot_finding', podName: 'api-2', containerName: 'api' } })]);
  assert.equal((await history()).length, 5);
});

it('records severity and reason changes immediately, including a return to the prior condition', async () => {
  await ingest([observation()]);
  await ingest([observation({ severity: 'critical' })]);
  await ingest([observation()]);
  await ingest([observation({ reason: 'ImagePullBackOff' })]);
  assert.equal((await history()).length, 4);
});

it('records reopening immediately without changing issue lifecycle behavior', async () => {
  await ingest([observation()]);
  await ingest([], '2026-10-01T00:11:00Z');
  assert.equal((await db.query('SELECT status FROM target_issues')).rows[0].status, 'resolved');
  await ingest([observation({ snapshotTs: '2026-10-01T00:12:00Z' })]);
  const issue = (await db.query('SELECT * FROM target_issues')).rows[0];
  assert.equal(issue.status, 'active');
  assert.equal(issue.reopened_count, 1);
  assert.equal(issue.lifecycle_version, 3);
  assert.equal((await history()).length, 2);
});

it('uses server time for hourly sampling even when agent timestamps jump ahead', async () => {
  await ingest([observation()]);
  await ingest([observation({ snapshotTs: '2099-01-01T00:00:00Z' })]);
  assert.equal((await history()).length, 1);
  await db.query("UPDATE target_issues SET last_observation_at=NOW()-INTERVAL '1 hour'");
  await ingest([observation({ snapshotTs: '2099-01-01T00:01:00Z' })]);
  assert.equal((await history()).length, 2);
  await ingest([observation({ snapshotTs: '2099-01-01T00:02:00Z' })]);
  assert.equal((await history()).length, 2);
});

it('serializes concurrent snapshots without adding duplicate history', async () => {
  await Promise.all(Array.from({ length: 8 }, () => ingest([observation()])));
  assert.equal((await history()).length, 1);
  assert.equal((await db.query('SELECT occurrence_count FROM target_issues')).rows[0].occurrence_count, 8);
});

it('records existing issues once after upgrade when sampling metadata is absent', async () => {
  await ingest([observation()]);
  await db.query('UPDATE target_issues SET last_observation_at=NULL,observation_signature=NULL');
  await ingest([observation()]);
  await ingest([observation()]);
  assert.equal((await history()).length, 2);
});

it('samples both VM service evidence sources without losing either source', async () => {
  await db.query(`INSERT INTO targets (id,workspace_id,target_type,name,status,metadata,created_at,updated_at)
    VALUES ('vm-1','workspace-1','virtual_machine','Test VM','online','{}',NOW(),NOW())`);
  const service = observation({ targetId: 'vm-1', targetType: 'virtual_machine', issueType: 'vm_service_unhealthy',
    scopeKind: null, scopeName: null, objectKind: 'systemd_service', objectName: 'backup.service', reason: 'failed', findingId: null,
    evidence: { source: 'vm_service_state', service: { unit: 'backup.service', active_state: 'failed', sub_state: 'failed' } }
  });
  const finding = { ...service, evidence: { source: 'vm_snapshot_finding', finding: { code: 'SERVICE_FAILED', unit: 'backup.service' } } };
  await ingest([service, finding]);
  await ingest([{ ...service, snapshotTs: '2026-10-01T00:01:00Z' }, { ...finding, snapshotTs: '2026-10-01T00:01:00Z' }]);
  assert.deepEqual((await history()).map(row => row.evidence.source).sort(), ['vm_service_state', 'vm_snapshot_finding']);
  assert.equal((await db.query('SELECT occurrence_count FROM target_issues')).rows[0].occurrence_count, 2);
});

async function expiredHistory(count: number) {
  const first = (await history())[0];
  await db.query(`INSERT INTO target_issue_observations
    (id,issue_id,workspace_id,target_id,target_type,snapshot_ts,severity,title,message,evidence,created_at)
    SELECT 'expired-' || n,issue_id,workspace_id,target_id,target_type,'2099-01-01',severity,title,message,evidence,
      NOW()-INTERVAL '31 days'
    FROM target_issue_observations CROSS JOIN generate_series(1,$2::int) n WHERE id=$1`, [first.id, count]);
}

it('purges expired history in bounded batches by server age and preserves the current issue', async () => {
  await ingest([observation({ snapshotTs: '2000-01-01T00:00:00Z' })]);
  await expiredHistory(5);
  const before = (await db.query('SELECT * FROM target_issues')).rows;
  assert.equal(await repo.purgeOldTargetIssueObservations(30, 2), 2);
  assert.equal((await history()).length, 4);
  assert.equal(await repo.purgeOldTargetIssueObservations(30, 500), 3);
  assert.equal(await repo.purgeOldTargetIssueObservations(30, 500), 0);
  assert.equal((await history()).length, 1);
  assert.deepEqual((await db.query('SELECT * FROM target_issues')).rows, before);
});

it('skips locked expired observations so cleanup does not block ingestion', async () => {
  await ingest([observation()]);
  await expiredHistory(3);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT id FROM target_issue_observations WHERE id='expired-1' FOR UPDATE");
    assert.equal(await repo.purgeOldTargetIssueObservations(30, 500), 2);
    assert.equal((await history()).length, 2);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(await repo.purgeOldTargetIssueObservations(30, 500), 1);
});
