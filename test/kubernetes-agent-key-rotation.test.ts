import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { agentGateway } from '../src/agent/ws-server.js';
import { rotateAgentKey } from '../src/controllers/workspaces/kubernetes-agent-key-controller.js';
import { repo } from '../src/store/repository.js';
import type { TargetAgentRegistration } from '../src/types/domain.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('Kubernetes agent key rotation', () => {
  it('requires manage_agent_keys and reuses the immutable RBAC snapshot', async () => {
    installWorkspace('operator');
    const denied = await callController(
      rotateAgentKey,
      createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' })
    );
    assert.equal(denied.statusCode, 403);

    installWorkspace('admin');
    const registration: TargetAgentRegistration = {
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      workspaceId: 'workspace-1',
      agentKeyHash: 'old-hash',
      keyVersion: 1
    };
    repo.getTargetAgentRegistration = async () => registration;
    repo.getClusterRbacAdditionsSnapshot = async () => ({
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
      }],
      sourceVersion: 4,
      contentHash: 'stored-snapshot-hash'
    });
    repo.rotateTargetAgentKey = async () => 2;
    let disconnectedClusterId = '';
    mock.method(agentGateway, 'disconnectCluster', async (clusterId: string) => {
      disconnectedClusterId = clusterId;
      return true;
    });

    const allowed = await callController(
      rotateAgentKey,
      createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' })
    );
    assert.equal(allowed.statusCode, 200);
    assert.equal(disconnectedClusterId, 'cluster-1');
    assert.match(
      (allowed.body as { installInstructions: { command: string } }).installInstructions.command,
      /--set-json rbac\.additions=.*cnpg/
    );

    repo.rotateTargetAgentKey = async () => null;
    const conflict = await callController(
      rotateAgentKey,
      createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' })
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.body as { error?: { code?: string } }).error?.code, 'AGENT_KEY_ROTATION_CONFLICT');
  });
});
