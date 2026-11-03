import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { upsertVirtualMachineSnapshot } from '../src/store/repository-virtual-machines.js';
import { deriveVirtualMachineIssueObservations } from '../src/services/target-issue-derivation.js';
import { canRecoverVirtualMachineIssue } from '../src/services/virtual-machine-issue-recovery.js';
import { summarizeVirtualMachineSnapshotMetrics } from '../src/services/target-metric-samples.js';
import { mapVirtualMachineMetricHistoryPoint } from '../src/services/virtual-machine-metric-history.js';
import { failedService, windowsSnapshot, windowsVm } from './helpers/windows-vm-snapshot-fixtures.js';

afterEach(() => mock.restoreAll());
function persistence(osFamily = 'windows') {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{
    id: windowsVm.id, workspace_id: windowsVm.workspaceId, name: windowsVm.name, status: 'online',
    metadata: osFamily === 'windows' ? { osFamily, serviceManager: 'scm' } : {},
    created_at: windowsVm.createdAt, updated_at: windowsVm.updatedAt
  }] }));
  mock.method(db, 'connect', async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      if (sql.includes('SELECT plan_key,lifecycle_status FROM workspaces')) return { rowCount: 1, rows: [{ plan_key: null, lifecycle_status: 'active' }] };
      if (sql.includes('INSERT INTO target_issues')) return { rowCount: 1, rows: [{ id: params[0], workspace_id: params[1], target_id: params[2], target_type: params[3], status: 'active', severity: 'critical', lifecycle_version: 1 }] };
      return { rowCount: 0, rows: [] };
    }, release() {}
  }));
  return writes;
}
it('persists native Windows inventory identities, findings and platform summary', async () => {
  const writes = persistence();
  await upsertVirtualMachineSnapshot(windowsSnapshot());
  const rows = JSON.parse(String(writes.find(({ sql }) => sql.includes('INSERT INTO target_inventory_items'))!.params[0]));
  assert.ok(rows.some((row: Record<string, unknown>) => row.kind === 'scm_service' && row.name === failedService.name && row.needs_attention === true));
  assert.ok(rows.some((row: Record<string, unknown>) => row.kind === 'filesystem' && row.name === 'C:' && row.status === 'pressure'));
  assert.ok(rows.some((row: Record<string, unknown>) => row.kind === 'host' && row.status === 'Windows 10.0 (20348)'));
  const summary = writes.find(({ sql }) => sql.includes('INSERT INTO target_snapshot_summaries'));
  assert.ok(summary);
  assert.match(JSON.stringify(summary.params), /windows/);
  assert.doesNotMatch(JSON.stringify(rows), /systemd_service/);
});
for (const [name, change] of [
  ['wrong version', { schema_version: 'acornops.agentv-snapshot.v2' }],
  ['missing version', { schema_version: undefined }],
  ['unknown outer field', { command_lines: ['secret'] }],
  ['unknown host field', { host_summary: { ...(windowsSnapshot().data.host_summary as object), command_line: 'secret' } }],
  ['Linux service row', { degraded_services: [{ unit: 'backup.service', active_state: 'failed' }] }],
  ['unknown volume field', { filesystems: [{ ...(windowsSnapshot().data.filesystems as object[])[0], mount: '/' }] }],
  ['oversized inventory', { listeners: Array(51).fill({ protocol: 'tcp', address: '::', port: 80, pid: null, ownership_status: 'unavailable' }) }],
  ['negative bytes', { filesystems: [{ ...(windowsSnapshot().data.filesystems as object[])[0], total_bytes: -1 }] }]
] as const) {
  it(`rejects Windows ${name} before telemetry writes`, async () => {
    const writes = persistence();
    await assert.rejects(upsertVirtualMachineSnapshot(windowsSnapshot(change)), /Windows snapshot/);
    assert.equal(writes.some(({ sql }) => /INSERT INTO target_(snapshots|inventory_items|metric_history)/.test(sql)), false);
  });
}
it('rejects Windows data for a stored legacy Linux VM', async () => {
  persistence('linux');
  await assert.rejects(upsertVirtualMachineSnapshot(windowsSnapshot()), /snapshot.*platform|Windows snapshot/i);
});
it('retains unavailable host and partial denied collection without fabricating metrics or resolving issues', async () => {
  persistence();
  const snapshot = windowsSnapshot({ host_summary: null, filesystems: [], degraded_services: [], findings: [],
    collector_health: [{ collector: 'windows_services', status: 'permission_denied', duration_ms: 1 }],
    finding_coverage: { filesystems: 'incomplete', services: 'incomplete' } });
  await upsertVirtualMachineSnapshot(snapshot);
  assert.equal(summarizeVirtualMachineSnapshotMetrics(snapshot), null);
  assert.equal(canRecoverVirtualMachineIssue(snapshot, { issueType: 'vm_service_unhealthy', reason: 'SERVICE_FAILED', objectName: failedService.name }), false);
});
it('uses the reported non-C system volume and leaves Windows load and swap unavailable', () => {
  const metrics = summarizeVirtualMachineSnapshotMetrics(windowsSnapshot())!;
  const point = mapVirtualMachineMetricHistoryPoint({ timestamp: windowsSnapshot().timestamp, metrics });
  assert.equal(point.rootDiskUsedBytes, 500);
  assert.equal(point.rootDiskTotalBytes, 2000);
  assert.equal(point.rootDiskUsedPercent, 25);
  assert.equal(point.memoryFreeBytes, 300);
  assert.equal(point.loadAverage1m, null);
  assert.equal(point.swapUsedBytes, null);
  const missing = windowsSnapshot({ filesystems: [ (windowsSnapshot().data.filesystems as object[])[0] ] });
  assert.equal(mapVirtualMachineMetricHistoryPoint({ timestamp: missing.timestamp, metrics: summarizeVirtualMachineSnapshotMetrics(missing)! }).rootDiskUsedBytes, null);
});
it('derives stable native service fingerprints with affirmative SCM failure evidence', () => {
  const issues = deriveVirtualMachineIssueObservations(windowsVm, windowsSnapshot());
  const service = issues.filter((issue) => issue.issueType === 'vm_service_unhealthy');
  assert.equal(service.length, 1);
  assert.equal(service[0].fingerprint, 'vm|vm-windows|scm_service|backupengine|service_failed');
  assert.equal(service[0].objectName, 'BackupEngine');
  assert.equal(service[0].objectKind, 'scm_service');
  const changed = windowsSnapshot({ degraded_services: [{ ...failedService, exit_code: 2, service_specific_exit_code: null }] });
  assert.equal(deriveVirtualMachineIssueObservations(windowsVm, changed)[0].fingerprint, service[0].fingerprint);
  for (const fields of [{ exit_code: 0 }, { exit_code: 1077 }, { exit_code: null }, { start_mode: 'Disabled' }, { start_mode: null }, { state: 'Running' }, { state: 'Start Pending' }]) {
    const snapshot = windowsSnapshot({ degraded_services: [{ ...failedService, ...fields }] });
    assert.equal(deriveVirtualMachineIssueObservations(windowsVm, snapshot).some((issue) => issue.issueType === 'vm_service_unhealthy'), false);
  }
});
it('recovers Windows issues only with explicit complete findings and successful native collection', () => {
  const issue = { issueType: 'vm_service_unhealthy', reason: 'SERVICE_FAILED', objectName: failedService.name };
  assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot(), issue), true);
  for (const status of ['partial', 'unavailable', 'permission_denied', 'timed_out']) {
    assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot({ collector_health: [{ collector: 'windows_services', status, duration_ms: 1 }] }), issue), false);
  }
  assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot({ finding_coverage: { filesystems: 'complete', services: 'incomplete' } }), issue), false);
  assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot({ collector_health: [] }), issue), false);
  assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot({ truncation: { filesystems: 0, services: 3, processes: 0, listeners: 0 } }), issue), true);
});
it('keeps complete producer findings after optional Windows inventories have been trimmed away', async () => {
  persistence();
  const snapshot = windowsSnapshot({ degraded_services: [], filesystems: [], truncation: { filesystems: 10, services: 10, processes: 0, listeners: 0 } });
  await upsertVirtualMachineSnapshot(snapshot);
  const issues = deriveVirtualMachineIssueObservations(windowsVm, snapshot);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].objectName, failedService.name);
  assert.equal(canRecoverVirtualMachineIssue(snapshot, { issueType: 'vm_host_finding', reason: 'FILESYSTEM_PRESSURE', objectName: 'Z:' }), true);
});
it('does not derive a failure from a normally stopped or disabled service alone', () => {
  for (const fields of [{ exit_code: 0 }, { exit_code: 1077 }, { start_mode: 'Disabled' }]) {
    assert.deepEqual(deriveVirtualMachineIssueObservations(windowsVm, windowsSnapshot({ findings: [], degraded_services: [{ ...failedService, ...fields }] })), []);
  }
});
it('retains nullable Windows volume, process and listener facts without substituting zeroes', async () => {
  persistence();
  const snapshot = windowsSnapshot({
    filesystems: [{ volume: 'D:', filesystem: null, total_bytes: null, free_bytes: null, used_bytes: null, used_percent: null }],
    top_processes: [{ pid: 10, ppid: null, name: 'worker', cpu_percent: null, memory_bytes: null, start_time: null }],
    listeners: [{ protocol: 'tcp', address: '::', port: 80, pid: null, ownership_status: 'permission_denied' }],
    finding_coverage: { filesystems: 'incomplete', services: 'complete' }
  });
  await upsertVirtualMachineSnapshot(snapshot);
  const point = mapVirtualMachineMetricHistoryPoint({ timestamp: snapshot.timestamp, metrics: summarizeVirtualMachineSnapshotMetrics(snapshot)! });
  assert.equal(point.rootDiskUsedBytes, null);
  assert.equal(point.rootDiskUsedPercent, null);
  assert.equal(canRecoverVirtualMachineIssue(snapshot, { issueType: 'vm_host_finding', reason: 'FILESYSTEM_PRESSURE', objectName: 'D:' }), false);
});
it('requires successful low memory evidence before recovering a Windows memory-pressure issue', () => {
  const issue = { issueType: 'vm_host_finding', reason: 'MEMORY_PRESSURE', objectName: 'server' };
  assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot(), issue), true);
  assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot({ host_summary: null }), issue), false);
  const host = windowsSnapshot().data.host_summary as Record<string, unknown>;
  assert.equal(canRecoverVirtualMachineIssue(windowsSnapshot({ host_summary: { ...host, memory: { ...(host.memory as object), used_percent: 95 } } }), issue), false);
});
