import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  getVirtualMachine,
  listVirtualMachineFindings,
  listVirtualMachineInventory,
  listVirtualMachines
} from '../src/controllers/workspaces/virtual-machine-controller.js';
import { repo } from '../src/store/repository.js';
import type { TargetFindingInput, TargetInventoryItemInput } from '../src/store/repository-target-inventory.js';
import type { TargetSummary, VirtualMachineSnapshot, VirtualMachineTarget } from '../src/types/domain.js';

const originalGetTarget = repo.getTarget;
const originalGetVirtualMachine = repo.getVirtualMachine;
const originalGetVirtualMachineSnapshot = repo.getVirtualMachineSnapshot;
const originalGetVirtualMachineSnapshotSummary = repo.getVirtualMachineSnapshotSummary;
const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalListVirtualMachineFindings = repo.listVirtualMachineFindings;
const originalListVirtualMachineInventory = repo.listVirtualMachineInventory;
const originalListVirtualMachines = repo.listVirtualMachines;
const originalListVirtualMachineSnapshotSummaries = repo.listVirtualMachineSnapshotSummaries;

afterEach(() => {
  repo.getTarget = originalGetTarget;
  repo.getVirtualMachine = originalGetVirtualMachine;
  repo.getVirtualMachineSnapshot = originalGetVirtualMachineSnapshot;
  repo.getVirtualMachineSnapshotSummary = originalGetVirtualMachineSnapshotSummary;
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.listVirtualMachineFindings = originalListVirtualMachineFindings;
  repo.listVirtualMachineInventory = originalListVirtualMachineInventory;
  repo.listVirtualMachines = originalListVirtualMachines;
  repo.listVirtualMachineSnapshotSummaries = originalListVirtualMachineSnapshotSummaries;
});

function createExternalIntegrationRequest(query: Record<string, string | undefined> = {}) {
  return {
    auth: {
      userId: 'user-1',
      credential: {
        type: 'external_integration' as const,
        integrationClientId: 'dev-client',
        provider: 'external',
        externalUserId: 'external-user-1'
      }
    },
    params: {
      workspaceId: 'workspace-1',
      vmId: 'vm-1'
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

function createVm(): VirtualMachineTarget {
  return {
    id: 'vm-1',
    workspaceId: 'workspace-1',
    name: 'vm-1',
    status: 'online',
    hostname: 'vm-1.local',
    osFamily: 'linux',
    serviceManager: 'systemd',
    allowedLogSources: ['journald'],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  };
}

function createTarget(): TargetSummary {
  return {
    id: 'vm-1',
    workspaceId: 'workspace-1',
    targetType: 'virtual_machine',
    name: 'vm-1',
    status: 'online',
    metadata: {},
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z'
  };
}

describe('external integration virtual machine reads', () => {
  it('allows external integration credentials to read VM list, overview, inventory, and findings', async () => {
    const vm = createVm();
    repo.getWorkspaceRole = async () => 'owner';
    repo.getTarget = async () => createTarget();
    repo.getVirtualMachine = async () => vm;
    repo.getVirtualMachineSnapshot = async (): Promise<VirtualMachineSnapshot> => ({
      targetId: 'vm-1',
      workspaceId: 'workspace-1',
      timestamp: '2026-06-01T00:01:00.000Z',
      data: {}
    });
    repo.getVirtualMachineSnapshotSummary = async () => ({
      latestSnapshot: {
        targetId: 'vm-1',
        workspaceId: 'workspace-1',
        timestamp: '2026-06-01T00:01:00.000Z'
      },
      summary: {
        inventoryCount: 1,
        findingCount: 1,
        criticalFindingCount: 0,
        serviceCount: 1,
        processCount: 0,
        listenerCount: 0,
        logCount: 0
      }
    });
    repo.listVirtualMachines = async () => ({ items: [vm], nextCursor: undefined });
    repo.listVirtualMachineSnapshotSummaries = async () => new Map([
      [
        'vm-1',
        {
          latestSnapshot: {
            targetId: 'vm-1',
            workspaceId: 'workspace-1',
            timestamp: '2026-06-01T00:01:00.000Z'
          },
          summary: {
            inventoryCount: 1,
            findingCount: 1,
            criticalFindingCount: 0,
            serviceCount: 1,
            processCount: 0,
            listenerCount: 0,
            logCount: 0
          }
        }
      ]
    ]);
    repo.listVirtualMachineInventory = async (): Promise<TargetInventoryItemInput[]> => [
      {
        targetId: 'vm-1',
        workspaceId: 'workspace-1',
        snapshotTs: '2026-06-01T00:01:00.000Z',
        itemId: 'service:sshd',
        category: 'service',
        kind: 'systemd_service',
        scopeKind: null,
        scopeName: null,
        name: 'sshd',
        status: 'running',
        location: null,
        needsAttention: false,
        sortKey: 'service:sshd',
        searchText: 'sshd',
        item: {}
      }
    ];
    repo.listVirtualMachineFindings = async (): Promise<TargetFindingInput[]> => [
      {
        targetId: 'vm-1',
        workspaceId: 'workspace-1',
        snapshotTs: '2026-06-01T00:01:00.000Z',
        findingId: 'finding-1',
        severity: 'warning',
        severityRank: 2,
        scopeKind: null,
        scopeName: null,
        objectKind: 'systemd_service',
        objectName: 'sshd',
        title: 'Service attention needed',
        message: 'Service needs attention.',
        reason: null,
        findingTs: '2026-06-01T00:01:00.000Z',
        searchText: 'service attention needed'
      }
    ];

    const list = createResponse();
    await listVirtualMachines(createExternalIntegrationRequest() as never, list as never, (err?: unknown) => {
      if (err) throw err;
    });
    const overview = createResponse();
    await getVirtualMachine(createExternalIntegrationRequest() as never, overview as never, (err?: unknown) => {
      if (err) throw err;
    });
    const inventory = createResponse();
    await listVirtualMachineInventory(createExternalIntegrationRequest() as never, inventory as never, (err?: unknown) => {
      if (err) throw err;
    });
    const findings = createResponse();
    await listVirtualMachineFindings(createExternalIntegrationRequest() as never, findings as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(list.statusCode, 200);
    assert.equal((list.body as { items: VirtualMachineTarget[] }).items[0].id, 'vm-1');
    assert.equal(overview.statusCode, 200);
    assert.equal((overview.body as VirtualMachineTarget & { latestSnapshot: { timestamp: string } }).latestSnapshot.timestamp, '2026-06-01T00:01:00.000Z');
    assert.equal(inventory.statusCode, 200);
    assert.equal((inventory.body as { items: TargetInventoryItemInput[] }).items[0].itemId, 'service:sshd');
    assert.equal(findings.statusCode, 200);
    assert.equal((findings.body as { items: TargetFindingInput[] }).items[0].findingId, 'finding-1');
  });
});
