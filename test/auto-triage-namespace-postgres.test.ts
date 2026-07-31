import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { startSingleTargetAutoTriageIssue } from '../src/store/repository-auto-triage-manual-actions.js';
import { enqueueAutoTriageForObservedIssue } from '../src/store/repository-target-issue-auto-triage.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);

async function insertIssue(id: string, namespace?: string): Promise<void> {
  await db.query(
    `INSERT INTO target_issues (
       id, workspace_id, target_id, target_type, fingerprint, issue_type, status,
       severity, severity_rank, title, summary, scope_kind, scope_name,
       first_seen_at, last_seen_at, last_observed_snapshot_at
     ) VALUES (
       $1, 'workspace-1', 'cluster-1', 'kubernetes', $1, 'finding', 'active',
       'warning', 1, $2, $2, $3, $4, NOW(), NOW(), NOW()
     )`,
    [id, `Issue ${id}`, namespace ? 'Namespace' : null, namespace || null]
  );
}

describe('target auto-triage namespace persistence', () => {
  it('rejects malformed namespace arrays at the database boundary', async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO target_auto_triage_settings (
           workspace_id, target_id, enabled, minimum_severity, write_mode,
           additional_instructions, namespace_include, namespace_exclude,
           include_cluster_scoped_issues, revision, updated_by
         ) VALUES (
           'workspace-1', 'cluster-1', TRUE, 'warning', 'read_only',
           '', '["Production"]'::jsonb, '[]'::jsonb, TRUE, 1, 'user-1'
         )`
      ),
      { code: '23514' }
    );
    await assert.rejects(
      db.query(
        `INSERT INTO target_auto_triage_settings (
           workspace_id, target_id, enabled, minimum_severity, write_mode,
           additional_instructions, namespace_include, namespace_exclude,
           include_cluster_scoped_issues, revision, updated_by
         ) VALUES (
           'workspace-1', 'cluster-1', TRUE, 'warning', 'read_only',
           '', '[42]'::jsonb, '[]'::jsonb, TRUE, 1, 'user-1'
         )`
      ),
      { code: '23514' }
    );
  });

  it('resolves missing settings to safe defaults and rejects stale revisions', async () => {
    assert.deepEqual(
      await repo.autoTriage.getTargetAutoTriageSettings('workspace-1', 'cluster-1'),
      {
        workspaceId: 'workspace-1',
        targetId: 'cluster-1',
        enabled: false,
        minimumSeverity: 'warning',
        writeMode: 'follow_target',
        additionalInstructions: '',
        namespaceInclude: [],
        namespaceExclude: [],
        includeClusterScopedIssues: true,
        revision: 0
      }
    );
    const saved = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: 0,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'read_only',
      additionalInstructions: '',
      namespaceInclude: [],
      namespaceExclude: [],
      includeClusterScopedIssues: true,
      updatedBy: 'user-1'
    });
    assert.ok(saved);
    assert.equal(saved.revision, 1);
    assert.equal(await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: 0,
      enabled: false,
      minimumSeverity: 'critical',
      writeMode: 'read_only',
      additionalInstructions: '',
      namespaceInclude: [],
      namespaceExclude: [],
      includeClusterScopedIssues: true,
      updatedBy: 'user-1'
    }), null);
  });

  it('queues only namespace-eligible Kubernetes issues while preserving cluster-scoped control', async () => {
    const settings = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: 0,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'read_only',
      additionalInstructions: '',
      namespaceInclude: ['payments', 'production'],
      namespaceExclude: ['production'],
      includeClusterScopedIssues: false,
      updatedBy: 'user-1'
    });
    assert.ok(settings);
    await insertIssue('issue-payments', 'payments');
    await insertIssue('issue-production', 'production');
    await insertIssue('issue-sandbox', 'sandbox');
    await insertIssue('issue-node');

    assert.equal(
      await repo.autoTriage.countEligibleCurrentAutoTriageIssues(
        'workspace-1',
        'cluster-1',
        'warning'
      ),
      1
    );
    assert.deepEqual(
      await repo.autoTriage.enqueueCurrentTargetAutoTriageIssues({
        workspaceId: 'workspace-1',
        targetId: 'cluster-1',
        expectedSettingsRevision: settings.revision
      }),
      { queuedCount: 1, alreadyExistsCount: 0, skippedCount: 0 }
    );
    const jobs = await db.query<{ issue_id: string }>(
      `SELECT issue_id FROM target_auto_triage_jobs ORDER BY issue_id`
    );
    assert.deepEqual(jobs.rows.map((row) => row.issue_id), ['issue-payments']);

    await db.query('DELETE FROM target_auto_triage_jobs');
    const client = await db.connect();
    try {
      const paymentsIssue = await repo.getTargetIssue('workspace-1', 'issue-payments');
      const sandboxIssue = await repo.getTargetIssue('workspace-1', 'issue-sandbox');
      assert.ok(paymentsIssue);
      assert.ok(sandboxIssue);
      await enqueueAutoTriageForObservedIssue(client, paymentsIssue);
      await enqueueAutoTriageForObservedIssue(client, sandboxIssue);
    } finally {
      client.release();
    }
    const observedJobs = await db.query<{ issue_id: string }>(
      `SELECT issue_id FROM target_auto_triage_jobs ORDER BY issue_id`
    );
    assert.deepEqual(observedJobs.rows.map((row) => row.issue_id), ['issue-payments']);
  });

  it('applies current namespace policy to manual starts and retries', async () => {
    const settings = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: 0,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'read_only',
      additionalInstructions: '',
      namespaceInclude: ['payments'],
      namespaceExclude: [],
      includeClusterScopedIssues: false,
      updatedBy: 'user-1'
    });
    assert.ok(settings);
    await insertIssue('issue-sandbox', 'sandbox');
    const issue = await repo.getTargetIssue('workspace-1', 'issue-sandbox');
    assert.ok(issue);
    assert.equal(
      await startSingleTargetAutoTriageIssue(issue, settings.revision),
      null
    );

    assert.equal(
      await repo.autoTriage.enqueueTargetAutoTriageJob(
        db,
        issue,
        'existing_issue_start',
        settings.revision
      ),
      true
    );
    await db.query(
      `UPDATE target_auto_triage_jobs
          SET status = 'failed',
              error_code = 'DISPATCH_FAILED'
        WHERE issue_id = $1`,
      [issue.id]
    );
    assert.equal(
      await repo.autoTriage.retryTargetAutoTriageIssue('workspace-1', issue.id),
      null
    );

    const expanded = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: settings.revision,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'read_only',
      additionalInstructions: '',
      namespaceInclude: ['sandbox'],
      namespaceExclude: [],
      includeClusterScopedIssues: false,
      updatedBy: 'user-1'
    });
    assert.ok(expanded);
    const retried = await repo.autoTriage.retryTargetAutoTriageIssue(
      'workspace-1',
      issue.id
    );
    assert.ok(retried);
    assert.equal(retried.settingsRevision, expanded.revision);
  });
});
