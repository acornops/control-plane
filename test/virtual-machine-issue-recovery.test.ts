import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canRecoverVirtualMachineIssue } from '../src/services/virtual-machine-issue-recovery.js';
import type { VirtualMachineSnapshot } from '../src/types/domain.js';

function snapshot(data: VirtualMachineSnapshot['data'] = {}): VirtualMachineSnapshot {
  return {
    targetId: 'vm-1', workspaceId: 'workspace-1', timestamp: '2026-10-26T00:00:00.000Z',
    data: {
      host_summary: { memory: { used_percent: 40 } },
      filesystems: [{ mount: '/', used_percent: 40 }],
      collector_health: ['host_facts', 'filesystems', 'systemd'].map((collector) => ({ collector, status: 'ok' })),
      truncation: { filesystems: 0, services: 0 },
      ...data
    }
  };
}

const filesystemIssue = { issueType: 'vm_host_finding', reason: 'FILESYSTEM_PRESSURE', objectName: '/var' };
const serviceIssue = { issueType: 'vm_service_unhealthy', reason: 'failed', objectName: 'backup.service' };
const memoryIssue = { issueType: 'vm_host_finding', reason: 'MEMORY_PRESSURE', objectName: 'host' };

describe('VM issue recovery coverage', () => {
  it('allows normal recovery after complete healthy collection, including a removed mount', () => {
    for (const issue of [filesystemIssue, serviceIssue, memoryIssue]) {
      assert.equal(canRecoverVirtualMachineIssue(snapshot(), issue), true);
    }
  });

  it('does not treat a missing or failed filesystem collector as proof of recovery', () => {
    for (const status of ['partial', 'unavailable', 'permission_denied', 'timed_out']) {
      assert.equal(canRecoverVirtualMachineIssue(snapshot({
        collector_health: [{ collector: 'filesystems', status }]
      }), filesystemIssue), false);
    }
    assert.equal(canRecoverVirtualMachineIssue(snapshot({ collector_health: [] }), filesystemIssue), false);
  });

  it('only recovers sampled mounts when filesystem inventory is truncated', () => {
    const partial = snapshot({ truncation: { filesystems: 20, services: 0 } });
    assert.equal(canRecoverVirtualMachineIssue(partial, filesystemIssue), false);
    assert.equal(canRecoverVirtualMachineIssue(partial, { ...filesystemIssue, objectName: '/' }), true);
    assert.equal(canRecoverVirtualMachineIssue(partial, serviceIssue), true);
  });

  it('recovers an omitted mount only with explicit complete findings and a healthy collector', () => {
    const data = {
      truncation: { filesystems: 12, services: 0 },
      finding_coverage: { filesystems: 'complete' }
    };
    assert.equal(canRecoverVirtualMachineIssue(snapshot(data), filesystemIssue), true);
    assert.equal(canRecoverVirtualMachineIssue(snapshot({
      ...data, finding_coverage: { filesystems: 'incomplete' }
    }), filesystemIssue), false);
    assert.equal(canRecoverVirtualMachineIssue(snapshot({
      ...data, collector_health: [{ collector: 'filesystems', status: 'unavailable' }]
    }), filesystemIssue), false);
  });

  it('keeps missing failed-service issues open when service collection is incomplete', () => {
    assert.equal(canRecoverVirtualMachineIssue(snapshot({ truncation: { filesystems: 0, services: 1 } }), serviceIssue), false);
    assert.equal(canRecoverVirtualMachineIssue(snapshot({
      collector_health: [{ collector: 'systemd', status: 'unavailable' }]
    }), serviceIssue), false);
  });

  it('recovers a service after inventory trimming only when service findings are complete', () => {
    const data = { truncation: { filesystems: 0, services: 1 } };
    assert.equal(canRecoverVirtualMachineIssue(snapshot({
      ...data, finding_coverage: { services: 'complete' }
    }), serviceIssue), true);
    assert.equal(canRecoverVirtualMachineIssue(snapshot({
      ...data, finding_coverage: { services: 'incomplete' }
    }), serviceIssue), false);
  });

  it('requires actual memory data and successful host collection for memory recovery', () => {
    assert.equal(canRecoverVirtualMachineIssue(snapshot({ host_summary: null }), memoryIssue), false);
    assert.equal(canRecoverVirtualMachineIssue(snapshot({ host_summary: { memory: {} } }), memoryIssue), false);
    assert.equal(canRecoverVirtualMachineIssue(snapshot({
      collector_health: [{ collector: 'host_facts', status: 'unavailable' }]
    }), memoryIssue), false);
  });
});
