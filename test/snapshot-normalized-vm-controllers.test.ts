import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listVirtualMachines } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { repo } from '../src/store/repository.js';
import type { VirtualMachineTarget } from '../src/types/domain.js';

const originalGetVirtualMachineSnapshot = repo.getVirtualMachineSnapshot;
const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalListVirtualMachines = repo.listVirtualMachines;
const originalListVirtualMachineSnapshotSummaries = repo.listVirtualMachineSnapshotSummaries;

afterEach(() => {
  repo.getVirtualMachineSnapshot = originalGetVirtualMachineSnapshot;
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.listVirtualMachines = originalListVirtualMachines;
  repo.listVirtualMachineSnapshotSummaries = originalListVirtualMachineSnapshotSummaries;
});

function createRequest(query: Record<string, string | undefined> = {}) {
  return {
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    },
    params: {
      workspaceId: 'workspace-1'
    },
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

function createVirtualMachine(id = 'vm-1'): VirtualMachineTarget {
  return {
    id,
    workspaceId: 'workspace-1',
    name: id,
    status: 'online',
    hostname: `${id}.local`,
    osFamily: 'linux',
    serviceManager: 'systemd',
    allowedLogSources: ['journald'],
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z'
  };
}

describe('normalized virtual machine snapshot controller reads', () => {
  it('uses normalized summaries for virtual machine list payloads', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getVirtualMachineSnapshot = async () => {
      throw new Error('VM list should not read raw snapshots');
    };
    repo.listVirtualMachines = async () => ({
      items: [createVirtualMachine()],
      nextCursor: undefined
    });
    repo.listVirtualMachineSnapshotSummaries = async () => new Map([
      [
        'vm-1',
        {
          latestSnapshot: {
            targetId: 'vm-1',
            workspaceId: 'workspace-1',
            timestamp: '2026-05-10T00:00:00.000Z'
          },
          summary: {
            inventoryCount: 11,
            findingCount: 2,
            criticalFindingCount: 1,
            serviceCount: 3,
            processCount: 42,
            listenerCount: 4,
            logCount: 9
          }
        }
      ]
    ]);
    const res = createResponse();

    await listVirtualMachines(createRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { items: Array<{ summary: { processCount: number } }> }).items[0].summary.processCount, 42);
  });
});
