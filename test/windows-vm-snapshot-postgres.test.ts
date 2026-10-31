import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import WebSocket from 'ws';
import { AgentGateway } from '../src/agent/ws-server.js';
import { setAgentConnection } from '../src/agent/connections.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { upsertVirtualMachineSnapshot } from '../src/store/repository-virtual-machines.js';
import { repo } from '../src/store/repository.js';
import { resetAutomationDatabaseFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';
import { FakeWebSocket, installRedisStore, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';
import { windowsSnapshot, windowsVm } from './helpers/windows-vm-snapshot-fixtures.js';

describe('Windows snapshot persistence through authenticated websocket ingress', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
    await db.query(`INSERT INTO targets (id,workspace_id,target_type,name,status,metadata,created_at,updated_at)
      VALUES ($1,'workspace-1','virtual_machine','Windows VM','online','{"osFamily":"windows","serviceManager":"scm"}',NOW(),NOW()),
      ('vm-linux','workspace-1','virtual_machine','Legacy Linux VM','online','{}',NOW(),NOW())`, [windowsVm.id]);
    setupControlPlaneCoordinationTest();
  });
  afterEach(() => teardownControlPlaneCoordinationTest());
  after(closeAutomationDatabaseFixtures);

  it('stores native inventory/metrics/findings and keeps incomplete collection from advancing recovery', async () => {
    const ws = new FakeWebSocket();
    setAgentConnection(windowsVm.id, { connectionId: 'conn', clusterId: windowsVm.id, workspaceId: 'workspace-1', keyVersion: 1, targetType: 'virtual_machine', ws: ws as unknown as WebSocket });
    mock.method(repo, 'getTargetAgentRegistration', async () => ({ keyVersion: 1 }) as Awaited<ReturnType<typeof repo.getTargetAgentRegistration>>);
    installRedisStore(new Map([[`cp:agent:owner:${windowsVm.id}`, JSON.stringify({ instanceId: config.CONTROL_PLANE_INSTANCE_ID, connectionId: 'conn', workspaceId: 'workspace-1', updatedAt: new Date().toISOString() })]]));
    const gateway = new AgentGateway() as unknown as { handleMessage(ws: WebSocket, raw: Buffer, key: string, version: string): Promise<void> };
    const send = async (data: Record<string, unknown>, timestamp = windowsSnapshot().timestamp) => gateway.handleMessage(ws as unknown as WebSocket,
      gzipSync(JSON.stringify({ jsonrpc: '2.0', method: 'notify/snapshot', params: { timestamp, data } })), '', 'agentv/test');
    await send(windowsSnapshot().data);
    const inventory = await db.query('SELECT kind,name FROM target_inventory_items WHERE target_id=$1', [windowsVm.id]);
    assert.ok(inventory.rows.some((row) => row.kind === 'scm_service' && row.name === 'BackupEngine'));
    assert.ok(inventory.rows.some((row) => row.name === 'D:'));
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM target_findings WHERE target_id=$1', [windowsVm.id])).rows[0].count, 2);
    const metrics = (await db.query('SELECT metrics FROM target_metric_history WHERE target_id=$1', [windowsVm.id])).rows[0].metrics;
    assert.equal(metrics.systemVolume, 'D:');
    assert.equal(metrics.swap, null);
    await assert.rejects(send({ ...windowsSnapshot().data, schema_version: 'acornops.agentv-snapshot.v2' }, '2026-10-31T01:01:00.000Z'), /Windows snapshot/);
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM target_metric_history WHERE target_id=$1', [windowsVm.id])).rows[0].count, 1);
    const clean = windowsSnapshot({ findings: [], degraded_services: [] }).data;
    await send({ ...clean, collector_health: [{ collector: 'windows_services', status: 'permission_denied', duration_ms: 1 }], finding_coverage: { services: 'incomplete', filesystems: 'incomplete' } }, '2026-10-31T01:05:00.000Z');
    const issue = (await db.query("SELECT status,clean_snapshot_count FROM target_issues WHERE target_id=$1 AND issue_type='vm_service_unhealthy'", [windowsVm.id])).rows[0];
    assert.deepEqual(issue, { status: 'active', clean_snapshot_count: 0 });
    await send(clean, '2026-10-31T01:10:00.000Z');
    assert.equal((await db.query("SELECT clean_snapshot_count FROM target_issues WHERE target_id=$1 AND issue_type='vm_service_unhealthy'", [windowsVm.id])).rows[0].clean_snapshot_count, 1);
    await upsertVirtualMachineSnapshot({ ...windowsSnapshot(), targetId: 'vm-linux', data: { host_summary: { cpu: { usage_percent: 2 } }, degraded_services: [{ unit: 'legacy.service', active_state: 'failed', sub_state: 'failed' }] } });
    assert.equal((await db.query("SELECT fingerprint FROM target_issues WHERE target_id='vm-linux'")).rows[0].fingerprint, 'vm|vm-linux|systemd_service|legacy.service|failed|failed');
    await assert.rejects(upsertVirtualMachineSnapshot({ ...windowsSnapshot(), targetId: 'vm-linux' }), /stored VM platform/);
  });
});
