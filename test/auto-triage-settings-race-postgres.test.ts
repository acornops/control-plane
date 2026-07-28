import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { db } from '../src/infra/db.js';
import { createTargetAutoTriageSessionAndRun } from '../src/services/auto-triage-run-creation.js';
import { repo } from '../src/store/repository.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);

describe('target auto-triage settings concurrency', () => {
  it('does not create a session after auto-triage settings change', async () => {
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
    await db.query(
      `INSERT INTO target_issues (
         id,workspace_id,target_id,target_type,fingerprint,issue_type,status,severity,severity_rank,
         title,summary,first_seen_at,last_seen_at,last_observed_snapshot_at
       ) VALUES (
         'issue-settings-changed-before-create','workspace-1','cluster-1','kubernetes',
         'issue-settings-changed-before-create','finding','active','warning',1,
         'Settings changed issue','Settings changed issue',NOW(),NOW(),NOW()
       )`
    );
    const issue = await repo.getTargetIssue(
      'workspace-1',
      'issue-settings-changed-before-create'
    );
    assert.ok(issue);
    await repo.autoTriage.enqueueTargetAutoTriageJob(
      db,
      issue,
      'existing_issue_start',
      settings.revision
    );
    const [job] = await repo.autoTriage.claimDueTargetAutoTriageJobs(
      'worker-stale-settings',
      1,
      120
    );
    assert.ok(job);
    assert.ok(await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      expectedRevision: settings.revision,
      enabled: false,
      minimumSeverity: 'warning',
      writeMode: 'read_only',
      additionalInstructions: '',
      updatedBy: 'user-1'
    }));

    await assert.rejects(
      createTargetAutoTriageSessionAndRun({
        job,
        issue,
        targetName: 'Test Cluster',
        settings,
        effective: {
          requestedWriteMode: 'read_only',
          effectiveToolMode: 'read_only',
          confirmationRequiredForWrite: false,
          targetCeilingApplied: false,
          targetSupportsWrite: true,
          summary: 'read_only'
        },
        llm: {
          provider: 'openai',
          model: 'gpt-5',
          allowedProviders: ['openai'],
          allowedProviderModels: { openai: ['gpt-5'] },
          allowedModels: ['gpt-5'],
          credentialConfigured: true,
          reasoning: { summary_mode: 'off', effort: 'low' }
        }
      }),
      { name: 'AutoTriageSettingsChangedError' }
    );
    const counts = await db.query<{ sessions: number; runs: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM sessions WHERE linked_issue_id = $1) AS sessions,
         (SELECT COUNT(*)::int
            FROM runs run
            JOIN sessions session ON session.id = run.session_id
           WHERE session.linked_issue_id = $1) AS runs`,
      [issue.id]
    );
    assert.deepEqual(counts.rows[0], { sessions: 0, runs: 0 });
  });
});
