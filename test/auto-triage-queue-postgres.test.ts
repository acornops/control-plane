import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);

async function enqueueIssue(issueId: string, settingsRevision: number): Promise<void> {
  await db.query(
    `INSERT INTO target_issues (
       id,workspace_id,target_id,target_type,fingerprint,issue_type,status,severity,severity_rank,
       title,summary,first_seen_at,last_seen_at,last_observed_snapshot_at
     ) VALUES ($1,'workspace-1','cluster-1','kubernetes',$1,'finding','active','warning',1,$2,$2,NOW(),NOW(),NOW())`,
    [issueId, `Issue ${issueId}`]
  );
  const issue = await repo.getTargetIssue('workspace-1', issueId);
  assert.ok(issue);
  assert.equal(
    await repo.autoTriage.enqueueTargetAutoTriageJob(
      db,
      issue,
      'existing_issue_start',
      settingsRevision
    ),
    true
  );
}

describe('target auto-triage queue visibility', () => {
  it('reports active, waiting, and oldest-waiting state from worker admission data', async () => {
    const settings = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: 0,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'read_only',
      additionalInstructions: '',
      updatedBy: 'user-1'
    });
    assert.ok(settings);
    for (const issueId of ['queue-issue-1', 'queue-issue-2', 'queue-issue-3']) {
      await enqueueIssue(issueId, settings.revision);
    }

    assert.equal(
      await repo.autoTriage.claimDueTargetAutoTriageJobs('queue-worker', 25, 120)
        .then((jobs) => jobs.length),
      2
    );

    const summary = await repo.autoTriage.getTargetAutoTriageQueueSummary(
      'workspace-1',
      'cluster-1'
    );
    assert.equal(summary.activeCount, 2);
    assert.equal(summary.waitingCount, 1);
    assert.ok(summary.oldestWaitingAt);

    const metrics = await repo.autoTriage.getAutoTriageRuntimeMetricsSnapshot();
    assert.equal(metrics.activeRuns, 0);
    assert.equal(metrics.queued, 1);
    assert.equal(metrics.blocked, 0);
    assert.equal(metrics.processing, 2);
    assert.equal(metrics.started, 0);
    assert.equal(metrics.stopping, 0);
    assert.ok(metrics.oldestWaitingAgeSeconds >= 0);
  });
});
