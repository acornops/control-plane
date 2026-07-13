import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getTargetAssistantCapabilitiesPreview } from '../src/controllers/workspaces/target-assistant-preview-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  createTarget,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target assistant capabilities preview validation', () => {
  it('enforces write run permission for read-write previews', async () => {
    installWorkspace('viewer');
    const response = await callController(
      getTargetAssistantCapabilitiesPreview,
      Object.assign(createRequest({ workspaceId: 'workspace-1', targetId: 'target-1' }), {
        query: { toolAccessMode: 'read_write' }
      })
    );

    assert.equal(response.statusCode, 403);
  });

  it('requires an explicit preview access mode', async () => {
    installWorkspace('operator');
    repo.getTarget = async () => createTarget({ id: 'target-1', name: 'vm', targetType: 'virtual_machine' });

    const response = await callController(
      getTargetAssistantCapabilitiesPreview,
      createRequest({ workspaceId: 'workspace-1', targetId: 'target-1' })
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
  });

  it('rejects unsupported target types before resolving tools', async () => {
    installWorkspace('operator');
    repo.getTarget = async () => createTarget({ id: 'target-1', name: 'db', targetType: 'database' as never });

    const response = await callController(
      getTargetAssistantCapabilitiesPreview,
      createRequest({ workspaceId: 'workspace-1', targetId: 'target-1' })
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'UNSUPPORTED_TARGET_TYPE');
  });
});
