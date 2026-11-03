import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

describe('heartbeat observations through persisted read paths', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
    for (const [id, metadata] of [['linux', {}], ['windows', { osFamily: 'windows', serviceManager: 'scm' }]] as const) {
      await db.query(`INSERT INTO targets(id,workspace_id,target_type,name,status,metadata,created_at,updated_at)
        VALUES($1,'workspace-1','virtual_machine',$1,'degraded',$2::jsonb,NOW(),NOW())`, [id, JSON.stringify(metadata)]);
    }
    await db.query("UPDATE targets SET status='online' WHERE id='cluster-1'");
    for (const id of ['linux', 'windows', 'cluster-1']) {
      await db.query(`INSERT INTO target_agent_registrations
        (target_id,workspace_id,agent_key_hash,key_version,last_connection_id,last_heartbeat_at,last_seen_at)
        VALUES($1,'workspace-1','synthetic',1,'identity',NOW()-INTERVAL '5 minutes',NOW())`, [id]);
    }
  });
  after(closeAutomationDatabaseFixtures);

  test('all target reads expire silent connections without changing stored health or filters', async () => {
    const reads = [
      ...(await repo.listTargets('workspace-1')).items,
      ...await repo.listWorkspaceTargetSnapshot('workspace-1'),
      ...(await repo.listVirtualMachines('workspace-1', { status: 'degraded' })).items,
      ...(await repo.listClusters('workspace-1', { status: 'online' })).items,
      ...(await repo.listAdminTargets({ workspaceId: 'workspace-1' })).items,
      await repo.getTarget('workspace-1', 'linux'), await repo.getTargetById('linux'),
      await repo.getVirtualMachine('windows'), await repo.getCluster('cluster-1')
    ];
    assert.ok(reads.length >= 15);
    for (const target of reads) {
      assert.ok(target);
      assert.equal(target.connection?.state, 'disconnected', target.id);
      assert.equal(target.status, target.id === 'cluster-1' ? 'online' : 'degraded', target.id);
      assert.ok(target.connection?.observedAt);
      assert.ok(target.connection?.lastHeartbeatAt);
    }
    assert.equal((await repo.listVirtualMachines('workspace-1', { status: 'online' })).items.length, 0);
  });

  test('a new heartbeat restores reporting while missing registrations stay unknown', async () => {
    await db.query("UPDATE target_agent_registrations SET last_heartbeat_at=NOW() WHERE target_id='linux'");
    assert.equal((await repo.getVirtualMachine('linux'))?.connection?.state, 'connected');
    await db.query("DELETE FROM target_agent_registrations WHERE target_id='windows'");
    assert.equal((await repo.getVirtualMachine('windows'))?.connection?.state, 'unknown');
    assert.equal((await repo.listTargets('workspace-2')).items.some((target) => target.id === 'linux'), false);
  });
});
