import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { db } from '../src/infra/db.js';
import { updateTargetAgentSeen } from '../src/store/repository-target-agent-registrations.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

describe('persisted heartbeat receipts', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, () => {
beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await db.query(`INSERT INTO target_agent_registrations
    (target_id,workspace_id,agent_key_hash,key_version,last_connection_id,last_heartbeat_at,last_seen_at,last_authenticated_key_version)
    VALUES('cluster-1','workspace-1','synthetic-kept-key',2,'B','2026-11-02T00:01:00Z','2026-11-02T00:01:00Z',2)`);
});
after(closeAutomationDatabaseFixtures);

async function record(connectionId: string, receivedAt: string, keyVersion = 2) {
  const input: Parameters<typeof updateTargetAgentSeen>[1] & { expectedConnectionId: string } = {
    expectedConnectionId: connectionId, lastSeenAt: receivedAt,
    lastHeartbeatAt: receivedAt, lastAuthenticatedKeyVersion: keyVersion
  };
  await updateTargetAgentSeen('cluster-1', input);
}
async function state() {
  return (await db.query(`SELECT last_connection_id,last_heartbeat_at,last_seen_at,last_authenticated_key_version,
    agent_key_hash,key_version FROM target_agent_registrations WHERE target_id='cluster-1'`)).rows[0];
}

test('a delayed A heartbeat cannot refresh B or overwrite its authentication evidence', async () => {
  const before = await state();
  await record('A', '2026-11-02T00:02:00Z', 1);
  assert.deepEqual(await state(), before);
});

test('an older B heartbeat cannot move its last contact backward', async () => {
  const before = await state();
  await record('B', '2026-11-02T00:00:00Z');
  assert.deepEqual(await state(), before);
});

test('the current connection records receipt without changing identity, keys or target health', async () => {
  await db.query("UPDATE targets SET status='degraded',metadata='{\"kept\":true}'::jsonb WHERE id='cluster-1'");
  const before = await state();
  await record('B', '2026-11-02T00:02:00Z');
  const after = await state();
  assert.equal(after.last_heartbeat_at.toISOString(), '2026-11-02T00:02:00.000Z');
  assert.equal(after.last_seen_at.toISOString(), '2026-11-02T00:02:00.000Z');
  assert.deepEqual({ ...after, last_heartbeat_at: before.last_heartbeat_at, last_seen_at: before.last_seen_at }, before);
  const target = (await db.query("SELECT status,metadata FROM targets WHERE id='cluster-1'")).rows[0];
  assert.deepEqual(target, { status: 'degraded', metadata: { kept: true } });
});

test('a completed disconnect blocks a late heartbeat on that identity', async () => {
  await db.query("UPDATE target_agent_registrations SET last_connection_id=NULL WHERE target_id='cluster-1'");
  const before = await state();
  await record('B', '2026-11-02T00:02:00Z');
  assert.deepEqual(await state(), before);
});

});
