import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listKubernetesRbacAdditions } from '../src/controllers/workspaces/kubernetes-rbac-additions-controller.js';
import { applyPlatformSettingOverrides } from '../src/services/platform-settings.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(() => {
  restoreControllerRegressionState();
  applyPlatformSettingOverrides([]);
});

describe('Kubernetes RBAC additions catalog', () => {
  it('requires target management and returns summaries without rule internals', async () => {
    applyPlatformSettingOverrides([{
      key: 'kubernetes_rbac_additions',
      overrideValue: {
        additions: [{
          key: 'cnpg',
          name: 'CNPG',
          description: 'CloudNativePG clusters',
          resources: [{
            apiGroup: 'postgresql.cnpg.io',
            apiVersion: 'v1',
            resource: 'clusters',
            kind: 'Cluster',
            scope: 'namespaced',
            verbs: ['list', 'patch']
          }]
        }]
      },
      version: 3,
      updatedBy: 'platform-admin',
      updatedAt: '2026-07-31T00:00:00.000Z'
    }]);

    installWorkspace('viewer');
    const denied = await callController(
      listKubernetesRbacAdditions,
      createRequest({ workspaceId: 'workspace-1' })
    );
    assert.equal(denied.statusCode, 403);

    installWorkspace('admin');
    const allowed = await callController(
      listKubernetesRbacAdditions,
      createRequest({ workspaceId: 'workspace-1' })
    );
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.body, {
      version: 3,
      items: [{ key: 'cnpg', name: 'CNPG', description: 'CloudNativePG clusters' }]
    });
    assert.doesNotMatch(JSON.stringify(allowed.body), /postgresql\.cnpg\.io|"verbs"|"apiVersion"|"resources"/);
  });
});
