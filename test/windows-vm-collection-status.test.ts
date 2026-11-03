import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import { upsertVirtualMachineSnapshot, listVirtualMachineInventory } from '../src/store/repository-virtual-machines.js';
import { listVirtualMachineInventory as resources } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { windowsSnapshot, windowsVm } from './helpers/windows-vm-snapshot-fixtures.js';
import { resetAutomationDatabaseFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

async function response(workspaceId = 'workspace-1') {
  const res = { statusCode: 0, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
  await resources({ auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
    params: { workspaceId, vmId: windowsVm.id }, query: {} } as never, res as never, (error) => { if (error) throw error; });
  return res;
}

describe('Windows snapshot collection status HTTP projection', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
    await db.query(`INSERT INTO targets(id,workspace_id,target_type,name,status,metadata,created_at,updated_at)
      VALUES($1,'workspace-1','virtual_machine','Windows','online','{"osFamily":"windows","serviceManager":"scm"}',NOW(),NOW())`, [windowsVm.id]);
  });
  after(closeAutomationDatabaseFixtures);
  for (const status of ['permission_denied', 'timed_out']) {
    it(`projects ${status} and partial counts with retained rows and the exact snapshot identity`, async () => {
      const snapshot = windowsSnapshot({ filesystems: [], collector_health: [
        { collector: 'windows_volumes', status, duration_ms: 1, message: '<script>untrusted</script>' },
        { collector: 'windows_processes', status: 'partial', duration_ms: 2 }
      ], top_processes: [{ pid: 10, ppid: null, name: 'kept-process', cpu_percent: null, memory_bytes: null, start_time: null }],
      finding_coverage: { filesystems: 'incomplete', services: 'complete' },
      truncation: { filesystems: 0, services: 0, processes: 3, listeners: 0 } });
      await upsertVirtualMachineSnapshot(snapshot);
      const res = await response();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.collectionStatus, { targetId: windowsVm.id, workspaceId: windowsVm.workspaceId,
        snapshotTs: snapshot.timestamp, categories: {
          host: { status: 'unknown' }, filesystems: { status, omittedCount: 0, findingCoverage: 'incomplete' },
          services: { status: 'unknown', omittedCount: 0, findingCoverage: 'complete' },
          processes: { status: 'partial', omittedCount: 3 }, network: { status: 'unknown', omittedCount: 0 }
        } });
      assert.ok(res.body.items.some((item: any) => item.name === 'kept-process'));
      assert.ok(res.body.items.every((item: any) => item.snapshotTs === res.body.collectionStatus.snapshotTs));
      assert.doesNotMatch(JSON.stringify(res.body.collectionStatus), /untrusted|duration_ms/);
      await upsertVirtualMachineSnapshot({ ...snapshot, timestamp: '2026-10-30T00:00:00.000Z' });
      assert.deepEqual((await response()).body, res.body);
      const next = windowsSnapshot({ collector_health: [], top_processes: [] });
      next.timestamp = '2026-10-31T02:00:00.000Z';
      await upsertVirtualMachineSnapshot(next);
      assert.equal((await response()).body.collectionStatus.snapshotTs, next.timestamp);
      assert.equal((await response('workspace-2')).statusCode, 404);
    });
  }
  it('marks a missing or mismatched read-model generation unknown instead of healthy empty', async () => {
    await upsertVirtualMachineSnapshot(windowsSnapshot());
    await db.query('DELETE FROM target_snapshot_summaries WHERE target_id=$1', [windowsVm.id]);
    assert.equal((await response()).body.collectionStatus, null);
    const next = { ...windowsSnapshot(), timestamp: '2026-10-31T02:00:00.000Z' };
    await upsertVirtualMachineSnapshot(next);
    await db.query('DELETE FROM target_inventory_items WHERE target_id=$1', [windowsVm.id]);
    assert.deepEqual((await response()).body, { items: [], collectionStatus: null });
  });
  it('returns unknown collection before the first snapshot and preserves the exact legacy Linux envelope', async () => {
    assert.deepEqual((await response()).body, { items: [], collectionStatus: null });
    await db.query(`UPDATE targets SET metadata='{}' WHERE id=$1`, [windowsVm.id]);
    const snapshot = { targetId: windowsVm.id, workspaceId: windowsVm.workspaceId, timestamp: windowsSnapshot().timestamp,
      data: { host_summary: { hostname: 'linux-host' }, degraded_services: [], top_processes: [], listeners: [], findings: [] } };
    await upsertVirtualMachineSnapshot(snapshot);
    assert.deepEqual((await response()).body, { items: await listVirtualMachineInventory(windowsVm.id) });
  });
});
