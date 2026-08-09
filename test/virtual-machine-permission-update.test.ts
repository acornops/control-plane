import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { updateVirtualMachine } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import type { VirtualMachineTarget } from '../src/types/domain.js';

afterEach(() => {
  mock.restoreAll();
});

function virtualMachine(permissionMode: VirtualMachineTarget['permissionMode'] = 'ask_before_changes'): VirtualMachineTarget {
  return {
    id: 'vm-1',
    workspaceId: 'workspace-1',
    name: 'vm-1',
    status: 'online',
    hostname: 'vm-1.internal',
    osFamily: 'linux',
    serviceManager: 'systemd',
    allowedLogSources: ['journald'],
    agentAccessMode: 'read_write',
    restartServices: ['nginx.service'],
    pendingAgentAccessPolicy: null,
    permissionMode,
    permissionModeOverride: permissionMode === 'ask_before_changes' ? null : permissionMode,
    permissionModeSource: permissionMode === 'ask_before_changes' ? 'deployment_default' : 'virtual_machine_override',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z'
  };
}

function response() {
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

describe('virtual machine run permission updates', () => {
  it('persists a VM-specific override without changing the host access policy', async () => {
    const previous = virtualMachine();
    let updateInput: unknown;
    let webhookEvent: unknown;
    mock.method(repo, 'getWorkspaceRole', async () => 'admin');
    mock.method(repo, 'getTarget', async () => ({
      id: previous.id,
      workspaceId: previous.workspaceId,
      targetType: 'virtual_machine',
      name: previous.name,
      status: previous.status,
      metadata: {},
      createdAt: previous.createdAt,
      updatedAt: previous.updatedAt
    }));
    mock.method(repo, 'getVirtualMachine', async () => previous);
    mock.method(repo, 'updateVirtualMachine', async (_vmId, input) => {
      updateInput = input;
      return {
        ...previous,
        permissionMode: 'read_only',
        permissionModeOverride: 'read_only',
        permissionModeSource: 'virtual_machine_override'
      };
    });
    mock.method(repo, 'insertWorkspaceAuditEvent', async () => undefined);
    mock.method(webhooks, 'emit', (event) => {
      webhookEvent = event;
    });
    const res = response();

    await updateVirtualMachine({
      auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
      params: { workspaceId: 'workspace-1', vmId: 'vm-1' },
      body: { permissionModeOverride: 'read_only' }
    } as never, res as never, (error?: unknown) => {
      if (error) throw error;
    });

    assert.deepEqual(updateInput, {
      name: undefined,
      hostname: undefined,
      allowedLogSources: undefined,
      permissionModeOverride: 'read_only'
    });
    assert.deepEqual((res.body as VirtualMachineTarget).restartServices, ['nginx.service']);
    assert.equal((res.body as VirtualMachineTarget).permissionMode, 'read_only');
    assert.deepEqual(webhookEvent, {
      type: 'target.updated.v1',
      workspaceId: 'workspace-1',
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      subject: { type: 'target', id: 'vm-1' },
      data: {
        targetType: 'virtual_machine',
        name: 'vm-1',
        status: 'online',
        hostname: 'vm-1.internal',
        allowedLogSources: ['journald'],
        permissionMode: 'read_only',
        permissionModeOverride: 'read_only',
        permissionModeSource: 'virtual_machine_override',
        updatedAt: '2026-08-09T00:00:00.000Z'
      }
    });
  });
});
