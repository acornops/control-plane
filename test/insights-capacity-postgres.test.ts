import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { assertInsightsExecution, withInsightsCapacity } from '../src/services/insights-capacity.js';
import { upsertTargetInsightsCheckpointJobForSessionActivity } from '../src/store/repository-target-insights-checkpoints.js';
import { resetAutomationDatabaseFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

after(closeAutomationDatabaseFixtures);
test('new Insights activity detaches the old reservation and fences superseded output', async () => {
  await resetAutomationDatabaseFixtures();
  const enabled = config.WORKSPACE_CAPACITY_ENABLED;
  config.WORKSPACE_CAPACITY_ENABLED = false;
  const first = '2026-09-01T01:00:00.000Z';
  const second = '2026-09-01T01:01:00.000Z';
  try {
    await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
      VALUES('insights-capacity-session','workspace-1','cluster-1','user-1','Insights','open',NOW(),NOW())`);
    await upsertTargetInsightsCheckpointJobForSessionActivity('insights-capacity-session', first);
    const claim = async (owner: string) => db.query(`UPDATE target_insights_checkpoint_jobs SET
      status='processing',lease_owner=$1,lease_expires_at=clock_timestamp()+INTERVAL '1 minute'
      WHERE session_id='insights-capacity-session'`, [owner]);
    await claim('first-owner');
    const job = { workspaceId: 'workspace-1', targetId: 'cluster-1', sessionId: 'insights-capacity-session' };
    await withInsightsCapacity({ ...job, leaseOwner: 'first-owner', lastActivityAt: first }, async (oldExecution) => {
      await upsertTargetInsightsCheckpointJobForSessionActivity(job.sessionId, second);
      assert.equal((await db.query('SELECT capacity_run_id FROM target_insights_checkpoint_jobs WHERE session_id=$1', [job.sessionId])).rows[0].capacity_run_id, null);
      await assert.rejects(assertInsightsExecution(oldExecution), { code: 'INSIGHTS_ATTEMPT_STALE' });
      await claim('second-owner');
      await withInsightsCapacity({ ...job, leaseOwner: 'second-owner', lastActivityAt: second }, async (newExecution) => {
        assert.notEqual(newExecution.runId, oldExecution.runId);
        await assertInsightsExecution(newExecution);
      });
    });
    const rows = await db.query("SELECT state FROM workspace_run_reservations WHERE workspace_id='workspace-1' AND pool='insights'");
    assert.equal(rows.rowCount, 2);
    assert.ok(rows.rows.every(row => row.state === 'settled'));
  } finally { config.WORKSPACE_CAPACITY_ENABLED = enabled; }
});
