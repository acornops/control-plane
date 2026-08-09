import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resolveTargetRunTools } from '../src/services/target-run-tool-resolution.js';
import { repo } from '../src/store/repository.js';
import { restoreControllerRegressionState } from './helpers/controller-regression-fixtures.js';
import {
  BASE_TOOLS,
  installResolverRepoStubs,
  mockToolList
} from './helpers/target-run-tool-resolution-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('AgentV pending policy run resolution', () => {
  it('filters write tools when the VM run policy is read-only', async () => {
    installResolverRepoStubs(['read', 'write']);
    repo.getVirtualMachine = async () => ({ permissionMode: 'read_only' }) as never;
    mockToolList(BASE_TOOLS);

    const result = await resolveTargetRunTools({
      workspaceId: 'workspace-1', targetId: 'target-1', targetType: 'virtual_machine',
      toolAccessMode: 'read_write', runId: 'run-1'
    });

    assert.equal(result.targetPermissionMode, 'read_only');
    assert.equal(result.confirmationRequiredForWrite, false);
    assert.equal(result.writeUnavailableReason, 'run_read_only');
    assert.equal(result.summary.writeAllowed, 0);
  });

  it('keeps AgentV writes available without approval under the VM auto-run policy', async () => {
    installResolverRepoStubs(['read', 'write']);
    repo.getVirtualMachine = async () => ({ permissionMode: 'auto_allowed_changes' }) as never;
    mockToolList(BASE_TOOLS);

    const result = await resolveTargetRunTools({
      workspaceId: 'workspace-1', targetId: 'target-1', targetType: 'virtual_machine',
      toolAccessMode: 'read_write', runId: 'run-1'
    });

    assert.equal(result.targetPermissionMode, 'auto_allowed_changes');
    assert.equal(result.confirmationRequiredForWrite, false);
    assert.equal(result.writeUnavailableReason, null);
    assert.ok(result.allowedToolNames.includes('restart_service'));
    assert.equal(result.summary.writeAllowed, 1);
  });

  it('fails closed on VM writes while a root host policy update is pending', async () => {
    installResolverRepoStubs(['read', 'write']);
    repo.getVirtualMachine = async () => ({
      permissionMode: 'auto_allowed_changes',
      pendingAgentAccessPolicy: { accessMode: 'read_write', restartServices: ['worker.service'] }
    }) as never;
    mockToolList(BASE_TOOLS);

    const result = await resolveTargetRunTools({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'virtual_machine',
      toolAccessMode: 'read_write',
      runId: 'run-1'
    });

    assert.equal(result.targetPermissionMode, 'read_only');
    assert.equal(result.confirmationRequiredForWrite, false);
    assert.equal(result.writeUnavailableReason, 'run_read_only');
    assert.ok(!result.allowedToolNames.includes('restart_service'));
  });
});
