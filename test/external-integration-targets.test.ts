import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getTarget, listTargets } from '../src/controllers/workspaces/target-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createExternalIntegrationRequest,
  createTarget,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('external integration target reads', () => {
  it('allows external integration credentials to list generic targets', async () => {
    installWorkspace('viewer');
    repo.listTargets = async (_workspaceId, options) => ({
      items: [
        createTarget({ id: 'cluster-1', targetType: 'kubernetes', name: 'cluster' }),
        createTarget({ id: 'target-1', targetType: 'virtual_machine', name: 'vm' })
      ],
      nextCursor: options.signature
    });

    const allowed = await callController(
      listTargets,
      createExternalIntegrationRequest({ workspaceId: 'workspace-1' })
    );

    assert.equal(allowed.statusCode, 200);
    const body = allowed.body as { items: Array<{ id: string; targetType: string }>; nextCursor?: string };
    assert.deepEqual(body.items.map((item) => [item.id, item.targetType]), [
      ['cluster-1', 'kubernetes'],
      ['target-1', 'virtual_machine']
    ]);
    assert.equal(typeof body.nextCursor, 'string');
  });

  it('allows external integration credentials to read generic target summaries', async () => {
    installWorkspace('viewer');

    const allowed = await callController(
      getTarget,
      createExternalIntegrationRequest({ workspaceId: 'workspace-1', targetId: 'target-1' })
    );

    assert.equal(allowed.statusCode, 200);
    assert.equal((allowed.body as { id: string; targetType: string }).id, 'target-1');
    assert.equal((allowed.body as { id: string; targetType: string }).targetType, 'virtual_machine');
  });
});
