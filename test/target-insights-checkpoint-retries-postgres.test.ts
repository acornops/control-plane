import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { withInsightsCapacity } from '../src/services/insights-capacity.js';
import { completeTargetInsightsCheckpoint } from '../src/services/target-insights/checkpoint-outcomes.js';
import { acquireRunCapacity, reserveRunCapacity } from '../src/store/repository-run-capacity.js';
import {
  claimDueTargetInsightsCheckpointJobs,
  finishTargetInsightsCheckpointJob,
  requeueTargetInsightsPausedCheckpoints,
  rescheduleTargetInsightsCheckpointJob,
  upsertTargetInsightsCheckpointJobForSessionActivity
} from '../src/store/repository-target-insights-checkpoints.js';
import { withTransaction } from '../src/store/repository-transaction.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

const originalDispatch = config.WORKSPACE_DISPATCH_ENABLED;
const originalCapacity = config.WORKSPACE_CAPACITY_ENABLED;
const originalPlans = config.WORKSPACE_PLANS;
const sessionId = 'checkpoint-retry-session';

async function seedJob(attempts = 0): Promise<string> {
  const activityAt = new Date(Date.now() - 45 * 60_000).toISOString();
  await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at,last_message_at,expires_at)
    VALUES($1,'workspace-1','cluster-1','user-1','Checkpoint retries','open',$2,$2,$2,NOW()+INTERVAL '1 day')`, [sessionId, activityAt]);
  await upsertTargetInsightsCheckpointJobForSessionActivity(sessionId, activityAt);
  await db.query('UPDATE target_insights_checkpoint_jobs SET attempts=$1 WHERE session_id=$2', [attempts, sessionId]);
  return activityAt;
}

async function readJob() {
  return (await db.query(`SELECT attempts,status,due_at,retry_after,last_error FROM target_insights_checkpoint_jobs
    WHERE session_id=$1`, [sessionId])).rows[0];
}

async function makeDue(): Promise<void> {
  await db.query(`UPDATE target_insights_checkpoint_jobs SET due_at=NOW()-INTERVAL '1 second',retry_after=NULL
    WHERE session_id=$1`, [sessionId]);
}

describe('Target Insights persisted retry budget', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, () => {
  beforeEach(resetAutomationDatabaseFixtures);
  afterEach(() => {
    config.WORKSPACE_DISPATCH_ENABLED = originalDispatch;
    config.WORKSPACE_CAPACITY_ENABLED = originalCapacity;
    config.WORKSPACE_PLANS = originalPlans;
  });
  after(closeAutomationDatabaseFixtures);

  it('refunds each deferred claim once while preserving earlier failed attempts', async () => {
    await seedJob(2);
    for (const reason of ['idle_delay_pending', 'run_active', 'approval_pending', 'state_changed']) {
      await makeDue();
      const [job] = await claimDueTargetInsightsCheckpointJobs(1, `owner-${reason}`);
      assert.equal((await readJob()).attempts, 3);
      const deferred = { ...job, dueAt: new Date(Date.now() + 60_000).toISOString(), error: reason };
      assert.equal(await rescheduleTargetInsightsCheckpointJob(deferred), true);
      assert.equal((await readJob()).attempts, 2);
      assert.equal(await rescheduleTargetInsightsCheckpointJob(deferred), false);
      assert.equal((await readJob()).attempts, 2);
    }
  });

  it('refunds dispatch maintenance deferrals without consuming provider eligibility', async () => {
    await seedJob(2);
    config.WORKSPACE_DISPATCH_ENABLED = false;
    const [job] = await claimDueTargetInsightsCheckpointJobs(1, 'maintenance-owner');
    await withInsightsCapacity(job, async () => { assert.fail('maintenance must defer provider work'); });
    const deferred = await readJob();
    assert.equal(deferred.status, 'queued');
    assert.equal(deferred.attempts, 2);
  });

  it('refunds capacity waits while retaining the reservation for the next claim', async () => {
    await seedJob(2);
    config.WORKSPACE_CAPACITY_ENABLED = true;
    const plan = originalPlans.plans[0];
    config.WORKSPACE_PLANS = { defaultPlanKey: plan.key, plans: [{ ...plan,
      executionLimits: { ...plan.executionLimits, insights: { maxConcurrentRuns: 1, maxOutstandingRuns: 3 } }
    }] };
    await withTransaction(client => reserveRunCapacity(client, {
      workspaceId: 'workspace-1', runId: 'occupied-insights-capacity', pool: 'insights'
    }));
    assert.equal((await acquireRunCapacity('occupied-insights-capacity', 'other-owner')).status, 'granted');
    const [job] = await claimDueTargetInsightsCheckpointJobs(1, 'waiting-owner');
    await withInsightsCapacity(job, async () => { assert.fail('capacity must defer provider work'); });
    assert.equal((await readJob()).attempts, 2);
    const reservation = await db.query('SELECT capacity_run_id FROM target_insights_checkpoint_jobs WHERE session_id=$1', [sessionId]);
    assert.ok(reservation.rows[0].capacity_run_id);
  });

  it('fences attempt refunds from expired leases and newer activity', async () => {
    const activityAt = await seedJob(2);
    const [job] = await claimDueTargetInsightsCheckpointJobs(1, 'expired-owner');
    await db.query("UPDATE target_insights_checkpoint_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE session_id=$1", [sessionId]);
    const deferred = { ...job, dueAt: new Date().toISOString(), error: 'run_active' };
    assert.equal(await rescheduleTargetInsightsCheckpointJob(deferred), false);
    config.WORKSPACE_DISPATCH_ENABLED = false;
    await withInsightsCapacity(job, async () => { assert.fail('expired work must not run'); });
    assert.equal((await readJob()).attempts, 3);
    assert.equal((await readJob()).status, 'processing');
    await upsertTargetInsightsCheckpointJobForSessionActivity(sessionId, new Date(new Date(activityAt).getTime() + 60_000).toISOString());
    assert.equal(await rescheduleTargetInsightsCheckpointJob(deferred), false);
    assert.equal((await readJob()).attempts, 0);
  });

  it('stops after the third failed claim and allows a new activity to retry', async () => {
    const activityAt = await seedJob();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await makeDue();
      const [job] = await claimDueTargetInsightsCheckpointJobs(1, `failure-owner-${attempt}`);
      assert.equal(job.attempts, attempt);
      assert.equal(await completeTargetInsightsCheckpoint(job, { provider: 'openai', model: 'model' }, {
        kind: 'provider_failure', reasonCode: 'provider_failure', proposedPatchCount: 0
      }), true);
      const failed = await readJob();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.attempts, attempt);
      assert.equal(failed.due_at !== null, attempt < 3);
      assert.equal(failed.retry_after !== null, attempt < 3);
    }
    assert.deepEqual(await claimDueTargetInsightsCheckpointJobs(1, 'exhausted-owner'), []);
    const nextActivityAt = new Date(new Date(activityAt).getTime() + 60_000).toISOString();
    await db.query('UPDATE sessions SET last_message_at=$2 WHERE id=$1', [sessionId, nextActivityAt]);
    await upsertTargetInsightsCheckpointJobForSessionActivity(sessionId, nextActivityAt);
    assert.equal((await readJob()).attempts, 0);
    const [nextJob] = await claimDueTargetInsightsCheckpointJobs(1, 'new-activity-owner');
    assert.equal(nextJob.attempts, 1);
    assert.equal(await completeTargetInsightsCheckpoint(nextJob, { provider: 'openai', model: 'model' }, {
      kind: 'provider_failure', reasonCode: 'provider_failure', proposedPatchCount: 0
    }), true);
    assert.ok((await readJob()).retry_after);
  });

  for (const earlierFailures of [0, 1, 2]) {
    it(`refunds repeated configuration skips while retaining ${earlierFailures} earlier failures`, async () => {
      await seedJob(earlierFailures);
      for (const reason of ['ai_settings_missing', 'tool_disabled', 'provider_not_allowed', 'model_not_allowed']) {
        const [job] = await claimDueTargetInsightsCheckpointJobs(1, `skipped-${reason}`);
        assert.equal(await finishTargetInsightsCheckpointJob({ ...job, status: 'skipped', error: reason }), true);
        assert.equal(await requeueTargetInsightsPausedCheckpoints('workspace-1', 'cluster-1'), 1);
        assert.equal((await readJob()).attempts, earlierFailures);
        assert.equal(await requeueTargetInsightsPausedCheckpoints('workspace-1', 'cluster-1'), 0);
        assert.equal((await readJob()).attempts, earlierFailures);
      }
      const [providerJob] = await claimDueTargetInsightsCheckpointJobs(1, 'provider-after-settings-fix');
      assert.equal(providerJob.attempts, earlierFailures + 1);
      assert.equal(await completeTargetInsightsCheckpoint(providerJob, { provider: 'openai', model: 'model' }, {
        kind: 'provider_failure', reasonCode: 'provider_failure', proposedPatchCount: 0
      }), true);
      assert.equal((await readJob()).retry_after !== null, earlierFailures < 2);
    });
  }
});
