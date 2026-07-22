import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listTargets } from '../src/controllers/workspaces/target-controller.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target controller validation', () => {
  it('rejects invalid target type filters instead of silently widening the target list', async () => {
    installWorkspace('viewer');
    const req = createRequest({ workspaceId: 'workspace-1' });
    req.query = { targetType: 'database' };

    const denied = await callController(listTargets, req);

    assert.equal(denied.statusCode, 400);
    assert.equal((denied.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    assert.match((denied.body as { error: { message: string } }).error.message, /targetType/);
  });
});
