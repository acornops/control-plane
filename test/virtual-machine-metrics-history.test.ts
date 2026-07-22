import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { getVirtualMachineMetricsHistory } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { summarizeVirtualMachineSnapshotMetrics } from '../src/services/target-metric-samples.js';
import { mapVirtualMachineMetricHistoryPoint } from '../src/services/virtual-machine-metric-history.js';
import { repo } from '../src/store/repository.js';
import type { TargetMetricHistoryPoint } from '../src/store/repository-target-metrics.js';
import type { TargetSummary } from '../src/types/domain.js';

const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalGetTarget = repo.getTarget;
const originalListTargetMetricHistory = repo.listTargetMetricHistory;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getTarget = originalGetTarget;
  repo.listTargetMetricHistory = originalListTargetMetricHistory;
  mock.reset();
});

function createRequest(query: Record<string, string | undefined> = {}) {
  return {
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    },
    params: { workspaceId: 'workspace-1', vmId: 'vm-1' },
    query
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

function createVmTarget(): TargetSummary {
  return {
    id: 'vm-1',
    workspaceId: 'workspace-1',
    targetType: 'virtual_machine',
    name: 'vm-1',
    status: 'online',
    hostname: 'vm-1.local',
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z'
  };
}

function createMetricPoint(metrics: Record<string, unknown>, workspaceId = 'workspace-1'): TargetMetricHistoryPoint {
  return {
    targetId: 'vm-1',
    workspaceId,
    targetType: 'virtual_machine',
    timestamp: '2026-05-25T00:00:00.000Z',
    metrics
  };
}

describe('virtual machine metric history normalization', () => {
  it('maps load, memory, swap, root disk, and optional CPU percent into flat VM telemetry', () => {
    const point = mapVirtualMachineMetricHistoryPoint(createMetricPoint({
      loadAverage: [0.1, 0.2, 0.3],
      cpuUsagePercent: 7.5,
      memory: { totalBytes: 1024, freeBytes: 256, usedBytes: 768 },
      swap: { totalBytes: 2048, freeBytes: 1536, usedBytes: 512 },
      disks: [
        { mount: '/var', usedBytes: 900, totalBytes: 1000 },
        { mount: '/', usedBytes: 128, totalBytes: 512 }
      ]
    }));

    assert.deepEqual(point, {
      timestamp: '2026-05-25T00:00:00.000Z',
      loadAverage1m: 0.1,
      loadAverage5m: 0.2,
      loadAverage15m: 0.3,
      cpuUsagePercent: 7.5,
      memoryUsedBytes: 768,
      memoryTotalBytes: 1024,
      memoryFreeBytes: 256,
      memoryUsedPercent: 75,
      swapUsedBytes: 512,
      swapTotalBytes: 2048,
      swapUsedPercent: 25,
      rootDiskUsedBytes: 128,
      rootDiskTotalBytes: 512,
      rootDiskUsedPercent: 25
    });
  });

  it('chooses the highest-utilization disk when no explicit root mount exists', () => {
    const point = mapVirtualMachineMetricHistoryPoint(createMetricPoint({
      disks: [
        { mount: '/data', usedBytes: 25, totalBytes: 100 },
        { mount: '/opt', usedBytes: 80, totalBytes: 100 }
      ]
    }));

    assert.equal(point.rootDiskUsedBytes, 80);
    assert.equal(point.rootDiskTotalBytes, 100);
    assert.equal(point.rootDiskUsedPercent, 80);
  });

  it('falls back to the highest valid disk when the explicit root disk is invalid', () => {
    const point = mapVirtualMachineMetricHistoryPoint(createMetricPoint({
      disks: [
        { mount: '/', usedBytes: 120, totalBytes: 100 },
        { mount: '/data', usedBytes: 60, totalBytes: 100 }
      ]
    }));

    assert.equal(point.rootDiskUsedBytes, 60);
    assert.equal(point.rootDiskTotalBytes, 100);
    assert.equal(point.rootDiskUsedPercent, 60);
  });

  it('returns nulls for invalid missing metric values', () => {
    const point = mapVirtualMachineMetricHistoryPoint(createMetricPoint({
      loadAverage: ['bad', -1],
      cpuUsagePercent: 101,
      memory: { totalBytes: 100, freeBytes: 101, usedBytes: 101 },
      swap: { totalBytes: 100, usedBytes: 101 },
      disks: [{ mount: '/', usedBytes: 1, totalBytes: 0 }]
    }));

    assert.equal(point.loadAverage1m, null);
    assert.equal(point.loadAverage5m, null);
    assert.equal(point.loadAverage15m, null);
    assert.equal(point.cpuUsagePercent, null);
    assert.equal(point.memoryUsedBytes, null);
    assert.equal(point.memoryFreeBytes, null);
    assert.equal(point.memoryUsedPercent, null);
    assert.equal(point.swapUsedBytes, null);
    assert.equal(point.swapUsedPercent, null);
    assert.equal(point.rootDiskUsedBytes, null);
    assert.equal(point.rootDiskTotalBytes, null);
    assert.equal(point.rootDiskUsedPercent, null);
  });

  it('does not compute usage percentages for zero-byte denominators', () => {
    const point = mapVirtualMachineMetricHistoryPoint(createMetricPoint({
      memory: { totalBytes: 0, freeBytes: 0, usedBytes: 0 },
      swap: { totalBytes: 0, freeBytes: 0, usedBytes: 0 },
      disks: [{ mount: '/', usedBytes: 0, totalBytes: 0 }]
    }));

    assert.equal(point.memoryUsedBytes, 0);
    assert.equal(point.memoryTotalBytes, 0);
    assert.equal(point.memoryUsedPercent, null);
    assert.equal(point.swapUsedBytes, 0);
    assert.equal(point.swapTotalBytes, 0);
    assert.equal(point.swapUsedPercent, null);
    assert.equal(point.rootDiskUsedBytes, null);
    assert.equal(point.rootDiskTotalBytes, null);
    assert.equal(point.rootDiskUsedPercent, null);
  });

  it('does not retain invalid VM CPU percent values from snapshots', () => {
    const summary = summarizeVirtualMachineSnapshotMetrics({
      data: {
        host_summary: {
          load: { one: 0.1, five: 0.2, fifteen: 0.3 },
          cpu: { usage_percent: 101 },
          memory: [],
          swap: []
        },
        filesystems: []
      }
    } as never);

    assert.deepEqual(summary, {
      loadAverage: [0.1, 0.2, 0.3],
      cpuUsagePercent: null,
      memory: null,
      swap: null,
      disks: []
    });
  });
});

describe('virtual machine metrics history endpoint', () => {
  it('returns VM-specific metric points without Kubernetes metric fields', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getTarget = async () => createVmTarget();
    repo.listTargetMetricHistory = async () => [
      createMetricPoint({
        loadAverage: [0.4, 0.3, 0.2],
        memory: { totalBytes: 1000, freeBytes: 250, usedBytes: 750 },
        swap: { totalBytes: 0, freeBytes: 0, usedBytes: 0 },
        disks: [{ mountpoint: '/', usedBytes: 60, totalBytes: 100 }]
      }),
      createMetricPoint({ loadAverage: [9, 9, 9] }, 'workspace-2')
    ];
    const res = createResponse();

    await getVirtualMachineMetricsHistory(createRequest({ window: '6h', limit: '24' }) as never, res as never, () => undefined);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      workspaceId: 'workspace-1',
      targetId: 'vm-1',
      windowMs: 6 * 60 * 60 * 1000,
      points: [
        {
          timestamp: '2026-05-25T00:00:00.000Z',
          loadAverage1m: 0.4,
          loadAverage5m: 0.3,
          loadAverage15m: 0.2,
          cpuUsagePercent: null,
          memoryUsedBytes: 750,
          memoryTotalBytes: 1000,
          memoryFreeBytes: 250,
          memoryUsedPercent: 75,
          swapUsedBytes: 0,
          swapTotalBytes: 0,
          swapUsedPercent: null,
          rootDiskUsedBytes: 60,
          rootDiskTotalBytes: 100,
          rootDiskUsedPercent: 60
        }
      ]
    });
    assert.equal(JSON.stringify(res.body).includes('cpuCores'), false);
    assert.equal(JSON.stringify(res.body).includes('memoryBytes'), false);
  });
});
