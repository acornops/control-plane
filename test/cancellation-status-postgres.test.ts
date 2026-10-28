import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { db } from '../src/infra/db.js';
import { listCancelledRunIds } from '../src/store/repository-run-cancellation.js';
import { coordinatedRoot } from './helpers/workflow-delegation-postgres-fixtures.js';
import { resetAutomationDatabaseFixtures, installAutomationTemplateFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

after(closeAutomationDatabaseFixtures);
test('durable cancellation query sees interactive status and workflow cancellation intent without a lease', async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  const { parent } = await coordinatedRoot();
  await db.query('UPDATE workflow_runs SET cancellation_requested_at=NOW() WHERE id=$1', [parent.id]);
  await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
    VALUES('cancel-session','workspace-1','cluster-1','user-1','Cancel','open',NOW(),NOW())`);
  for (const status of ['running', 'cancelling', 'cancelled']) {
    await db.query(`INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status,requested_at)
      VALUES($1,'workspace-1','cluster-1','cancel-session',$1,$2,NOW())`, [status, status]);
  }
  const result = await listCancelledRunIds([parent.id, 'running', 'cancelling', 'cancelled', 'missing']);
  assert.deepEqual(result.sort(), [parent.id, 'cancelling', 'cancelled'].sort());
});
