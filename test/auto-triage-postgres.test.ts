import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import {
  skipUnstartedTargetAutoTriageJobs,
  startSingleTargetAutoTriageIssue
} from '../src/store/repository-auto-triage-manual-actions.js';
import { createTargetAutoTriageSessionAndRun } from '../src/services/auto-triage-run-creation.js';
import { transitionLinkedRunWhileClaimed } from '../src/services/auto-triage-run-transitions.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';
beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);
async function insertIssue(
  id: string,
  severity: 'critical' | 'warning' | 'info' = 'warning'
): Promise<void> {
  const severityRank = severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
  await db.query(
    `INSERT INTO target_issues (
       id,workspace_id,target_id,target_type,fingerprint,issue_type,status,severity,severity_rank,
       title,summary,scope_kind,scope_name,first_seen_at,last_seen_at,last_observed_snapshot_at
     ) VALUES ($1,'workspace-1','cluster-1','kubernetes',$1,'finding','active',$2,$3,$4,$4,$5,$6,NOW(),NOW(),NOW())`,
    [id, severity, severityRank, `Issue ${id}`, null, null]
  );
}

async function enableAutoTriage() {
  const settings = await repo.autoTriage.saveTargetAutoTriageSettings({
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
  assert.ok(settings);
  return settings;
}

describe('target auto-triage persistence', () => {
  it('creates one job per issue lifecycle and enforces two claimed slots per target', async () => {
    const settings = await enableAutoTriage();
    for (const issueId of ['issue-1', 'issue-2', 'issue-3']) {
      await insertIssue(issueId);
      const issue = await repo.getTargetIssue('workspace-1', issueId);
      assert.ok(issue);
      assert.equal(
        await repo.autoTriage.enqueueTargetAutoTriageJob(db, issue, 'existing_issue_start', settings.revision),
        true
      );
      assert.equal(
        await repo.autoTriage.enqueueTargetAutoTriageJob(db, issue, 'retry', settings.revision),
        false
      );
    }

    const firstClaim = await repo.autoTriage.claimDueTargetAutoTriageJobs('worker-a', 25, 120);
    assert.equal(firstClaim.length, 2);
    assert.equal(await repo.autoTriage.claimDueTargetAutoTriageJobs('worker-b', 25, 120).then((jobs) => jobs.length), 0);
  });

  it('queues explicit retries with a fresh stable run generation and safe activity', async () => {
    const settings = await enableAutoTriage();
    await insertIssue('issue-retry');
    const issue = await repo.getTargetIssue('workspace-1', 'issue-retry');
    assert.ok(issue);
    await repo.autoTriage.enqueueTargetAutoTriageJob(db, issue, 'existing_issue_start', settings.revision);
    await db.query(
      `UPDATE target_auto_triage_jobs
          SET status='failed', run_id=NULL, error_code='DISPATCH_FAILED'
        WHERE issue_id='issue-retry'`
    );

    const retried = await repo.autoTriage.retryTargetAutoTriageIssue('workspace-1', 'issue-retry');
    assert.ok(retried);
    assert.equal(retried.retryGeneration, 1);
    assert.equal(retried.runId, undefined);
    assert.equal(retried.status, 'queued');

    const activity = await repo.autoTriage.getAutomaticInvestigationActivityByIssueIds(
      'workspace-1',
      ['issue-retry'],
      { readOnly: true, writeCapable: false }
    );
    assert.equal(activity.get('issue-retry')?.state, 'queued');
    assert.equal(activity.get('issue-retry')?.canRetry, false);
  });

  it('projects retry capability through both target-management and write-run permissions', async () => {
    const settings = await enableAutoTriage();
    await insertIssue('issue-retry-permissions');
    const issue = await repo.getTargetIssue('workspace-1', 'issue-retry-permissions');
    assert.ok(issue);
    await repo.autoTriage.enqueueTargetAutoTriageJob(
      db,
      issue,
      'existing_issue_start',
      settings.revision
    );
    await db.query(
      `UPDATE target_auto_triage_jobs
          SET status = 'failed',
              error_code = 'DISPATCH_FAILED'
        WHERE issue_id = $1`,
      [issue.id]
    );

    const readOnlyRetry = await repo.autoTriage.getAutomaticInvestigationActivityByIssueIds(
      'workspace-1',
      [issue.id],
      { readOnly: true, writeCapable: false }
    );
    assert.equal(readOnlyRetry.get(issue.id)?.canRetry, true);

    const writeSettings = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: settings.revision,
      enabled: true,
      minimumSeverity: 'warning',
      writeMode: 'approval_required',
      additionalInstructions: '',
      namespaceInclude: [],
      namespaceExclude: [],
      includeClusterScopedIssues: true,
      updatedBy: 'user-1'
    });
    assert.ok(writeSettings);
    const withoutWritePermission = await repo.autoTriage.getAutomaticInvestigationActivityByIssueIds(
      'workspace-1',
      [issue.id],
      { readOnly: true, writeCapable: false }
    );
    const withWritePermission = await repo.autoTriage.getAutomaticInvestigationActivityByIssueIds(
      'workspace-1',
      [issue.id],
      { readOnly: true, writeCapable: true }
    );
    assert.equal(withoutWritePermission.get(issue.id)?.canRetry, false);
    assert.equal(withWritePermission.get(issue.id)?.canRetry, true);
  });

  it('offers explicitly skipped current issues again after auto-triage is re-enabled', async () => {
    const settings = await enableAutoTriage();
    await insertIssue('issue-disabled-before-start');
    const issue = await repo.getTargetIssue('workspace-1', 'issue-disabled-before-start');
    assert.ok(issue);
    await repo.autoTriage.enqueueTargetAutoTriageJob(
      db,
      issue,
      'existing_issue_start',
      settings.revision
    );
    const skipped = await skipUnstartedTargetAutoTriageJobs('workspace-1', 'cluster-1');
    assert.equal(skipped.length, 1);
    assert.equal(
      await repo.autoTriage.countEligibleCurrentAutoTriageIssues('workspace-1', 'cluster-1', 'warning'),
      1
    );

    const result = await repo.autoTriage.enqueueCurrentTargetAutoTriageIssues({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedSettingsRevision: settings.revision
    });
    assert.deepEqual(result, { queuedCount: 1, alreadyExistsCount: 0, skippedCount: 0 });

    const job = await repo.autoTriage.getTargetAutoTriageJobForIssueLifecycle(
      'workspace-1',
      issue.id,
      issue.lifecycleVersion
    );
    assert.equal(job?.status, 'queued');
    assert.equal(job?.errorCode, undefined);
  });

  it('does not start one issue against a stale settings revision', async () => {
    const settings = await enableAutoTriage();
    await insertIssue('issue-stale-single-start');
    const issue = await repo.getTargetIssue('workspace-1', 'issue-stale-single-start');
    assert.ok(issue);
    const updated = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: settings.revision,
      enabled: true,
      minimumSeverity: 'critical',
      writeMode: 'read_only',
      additionalInstructions: '',
      namespaceInclude: [],
      namespaceExclude: [],
      includeClusterScopedIssues: true,
      updatedBy: 'user-1'
    });
    assert.ok(updated);

    assert.equal(
      await startSingleTargetAutoTriageIssue(issue, settings.revision),
      null
    );
    assert.equal(
      await repo.autoTriage.getTargetAutoTriageJobForIssueLifecycle(
        'workspace-1',
        issue.id,
        issue.lifecycleVersion
      ),
      null
    );
  });

  it('fences expired workers and resets the execution failure budget after readiness recovers', async () => {
    const settings = await enableAutoTriage();
    await insertIssue('issue-readiness-recovery');
    const issue = await repo.getTargetIssue('workspace-1', 'issue-readiness-recovery');
    assert.ok(issue);
    await repo.autoTriage.enqueueTargetAutoTriageJob(
      db,
      issue,
      'existing_issue_start',
      settings.revision
    );
    await db.query(
      `UPDATE target_auto_triage_jobs
          SET status = 'blocked',
              attempt_count = 7,
              next_attempt_at = NOW(),
              lease_owner = NULL,
              lease_expires_at = NULL
        WHERE issue_id = $1`,
      [issue.id]
    );

    const claimed = await repo.autoTriage.claimDueTargetAutoTriageJobs('worker-current', 1, 120);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].attemptCount, 8);
    assert.equal(
      await repo.autoTriage.resetClaimedTargetAutoTriageAttemptCount(claimed[0].id, 'worker-current'),
      true
    );
    const reset = await repo.autoTriage.getTargetAutoTriageJobForIssueLifecycle(
      'workspace-1',
      issue.id,
      issue.lifecycleVersion
    );
    assert.equal(reset?.attemptCount, 1);
    assert.equal(reset?.leaseOwner, 'worker-current');

    await db.query(
      `UPDATE target_auto_triage_jobs
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [claimed[0].id]
    );
    assert.equal(
      await repo.autoTriage.updateClaimedTargetAutoTriageJob({
        jobId: claimed[0].id,
        leaseOwner: 'worker-current',
        status: 'failed',
        errorCode: 'STALE_WORKER'
      }),
      false
    );
    assert.equal(
      await repo.autoTriage.resetClaimedTargetAutoTriageAttemptCount(claimed[0].id, 'worker-current'),
      false
    );
  });

  it('atomically creates one system-authored session and pinned run per issue lifecycle', async () => {
    const settings = await enableAutoTriage();
    await insertIssue('issue-run-creation');
    const issue = await repo.getTargetIssue('workspace-1', 'issue-run-creation');
    assert.ok(issue);
    await repo.autoTriage.enqueueTargetAutoTriageJob(
      db,
      issue,
      'existing_issue_start',
      settings.revision
    );
    const [job] = await repo.autoTriage.claimDueTargetAutoTriageJobs('worker-create', 1, 120);
    assert.ok(job);
    const input = {
      job,
      issue,
      targetName: 'Test Cluster',
      settings,
      effective: {
        requestedWriteMode: 'read_only' as const,
        effectiveToolMode: 'read_only' as const,
        confirmationRequiredForWrite: false,
        targetCeilingApplied: false,
        targetSupportsWrite: true,
        summary: 'read_only' as const
      },
      llm: {
        provider: 'openai' as const,
        model: 'gpt-5',
        allowedProviders: ['openai' as const],
        allowedProviderModels: { openai: ['gpt-5'] },
        allowedModels: ['gpt-5'],
        credentialConfigured: true,
        reasoning: { summary_mode: 'off' as const, effort: 'low' as const }
      }
    };
    const first = await createTargetAutoTriageSessionAndRun(input);
    const replay = await createTargetAutoTriageSessionAndRun(input);
    assert.equal(first.created.idempotent, false);
    assert.equal(replay.created.idempotent, true);
    assert.equal(replay.session.id, first.session.id);
    assert.equal(replay.created.run.id, first.created.run.id);

    const persistedSession = await repo.getSession(first.session.id);
    assert.equal(persistedSession?.origin, 'auto_triage');
    assert.equal(persistedSession?.createdBy, 'system-auto-triage');
    assert.equal(persistedSession?.automaticInvestigation?.issueId, issue.id);
    assert.equal(persistedSession?.automaticInvestigation?.effectiveToolMode, 'read_only');
    assert.deepEqual(first.created.run.principal, {
      type: 'service_identity',
      id: 'system-auto-triage'
    });
    assert.equal(first.created.run.confirmationRequiredForWriteOverride, false);
    assert.equal(first.created.message.createdBy, undefined);
    assert.equal(first.created.message.metadata?.presentation, 'automatic_investigation_brief');
    assert.equal(first.created.message.metadata?.systemAuthored, true);

    const counts = await db.query<{ sessions: number; messages: number; runs: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM sessions WHERE linked_issue_id = $1) AS sessions,
         (SELECT COUNT(*)::int FROM messages WHERE session_id = $2) AS messages,
         (SELECT COUNT(*)::int FROM runs WHERE session_id = $2) AS runs`,
      [issue.id, first.session.id]
    );
    assert.deepEqual(counts.rows[0], { sessions: 1, messages: 1, runs: 1 });
    const provenance = await db.query<{
      request_actor_type: string;
      confirmation_required_for_write_override: boolean | null;
    }>(
      `SELECT request_actor_type, confirmation_required_for_write_override
         FROM runs
        WHERE id = $1`,
      [first.created.run.id]
    );
    assert.deepEqual(provenance.rows[0], {
      request_actor_type: 'system',
      confirmation_required_for_write_override: false
    });

    await db.query(
      `UPDATE target_auto_triage_jobs
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [job.id]
    );
    const staleTransition = await transitionLinkedRunWhileClaimed(
      job,
      first.created.run,
      { status: 'failed', errorCode: 'STALE_WORKER' },
      { status: 'failed', runId: first.created.run.id, sessionId: first.session.id }
    );
    assert.equal(staleTransition, null);
    assert.equal((await repo.getRun(first.created.run.id))?.status, 'queued');
    assert.equal(
      (await repo.autoTriage.getTargetAutoTriageJobForIssueLifecycle(
        'workspace-1',
        issue.id,
        issue.lifecycleVersion
      ))?.status,
      'processing'
    );

    const [recoveredJob] = await repo.autoTriage.claimDueTargetAutoTriageJobs(
      'worker-recovery',
      1,
      120
    );
    assert.ok(recoveredJob);
    await repo.updateRun(first.created.run.id, {
      status: 'completed',
      endedAt: new Date().toISOString()
    });
    const staleRunStateTransition = await transitionLinkedRunWhileClaimed(
      recoveredJob,
      first.created.run,
      { status: 'dispatching' },
      { status: 'started', runId: first.created.run.id, sessionId: first.session.id }
    );
    assert.equal(staleRunStateTransition, null);
    assert.equal((await repo.getRun(first.created.run.id))?.status, 'completed');
    const reconciled = await repo.autoTriage.synchronizeTargetAutoTriageTerminalRuns();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].status, 'completed');

    assert.deepEqual(await repo.deleteSession(first.session.id), { status: 'deleted' });
    const deletedLink = await db.query<{
      session_id: string | null;
      session_created_at: Date | string | null;
    }>(
      `SELECT session_id, session_created_at
         FROM target_auto_triage_jobs
        WHERE issue_id = $1`,
      [issue.id]
    );
    assert.equal(deletedLink.rows[0]?.session_id, null);
    assert.ok(deletedLink.rows[0]?.session_created_at);

    await db.query('DELETE FROM target_issues WHERE id = $1', [issue.id]);
    const retained = await db.query<{
      linked_issue_id: string | null;
      job_count: number;
    }>(
      `SELECT s.linked_issue_id,
              (SELECT COUNT(*)::int
                 FROM target_auto_triage_jobs
                WHERE issue_id = $1) AS job_count
         FROM sessions s
        WHERE s.id = $2`,
      [issue.id, first.session.id]
    );
    assert.deepEqual(retained.rows[0], {
      linked_issue_id: null,
      job_count: 0
    });
  });
});
