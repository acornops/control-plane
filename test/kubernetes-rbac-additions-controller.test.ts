import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listKubernetesRbacAdditions } from '../src/controllers/workspaces/kubernetes-rbac-additions-controller.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('Kubernetes RBAC additions controller', () => {
  it('returns a truthful versioned empty catalog to target managers', async () => {
    installWorkspace('admin');
    const response = await callController(
      listKubernetesRbacAdditions,
      createRequest({ workspaceId: 'workspace-1' })
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { version: 1, items: [] });
  });

  it('does not expose onboarding options to workspace viewers', async () => {
    installWorkspace('viewer');
    const response = await callController(
      listKubernetesRbacAdditions,
      createRequest({ workspaceId: 'workspace-1' })
    );
    assert.equal(response.statusCode, 403);
  });
});
