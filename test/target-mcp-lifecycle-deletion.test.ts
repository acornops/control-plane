import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { agentGateway } from '../src/agent/ws-server.js';
import { deleteCluster } from '../src/controllers/workspaces/kubernetes-cluster-delete-controller.js';
import { deleteVirtualMachine } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target MCP lifecycle deletion', () => {
  it('uses privileged destination teardown for built-in and manual state on Kubernetes and VM targets', async () => {
    installWorkspace('admin');
    const operations: string[] = [];
    mock.method(repo, 'deleteCluster', async () => {
      operations.push('local:kubernetes');
      return true;
    });
    mock.method(repo, 'deleteVirtualMachine', async () => {
      operations.push('local:virtual_machine');
      return true;
    });
    mock.method(repo, 'enqueueWebhookOutboxEvent', async () => null);
    mock.method(agentGateway, 'disconnectCluster', async () => {
      operations.push('disconnect:virtual_machine');
    });
    const lifecycleQueries: Array<Record<string, string>> = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method, 'DELETE');
      assert.equal(url.pathname, '/api/v1/internal/mcp/destinations');
      const query = Object.fromEntries(url.searchParams);
      lifecycleQueries.push(query);
      operations.push(`gateway:${query.target_type}`);
      return new Response(null, { status: 204 });
    });

    const cluster = await callController(
      deleteCluster,
      createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' })
    );
    const virtualMachine = await callController(
      deleteVirtualMachine,
      createRequest({ workspaceId: 'workspace-1', vmId: 'target-1' })
    );

    assert.equal(cluster.statusCode, 204);
    assert.equal(virtualMachine.statusCode, 204);
    assert.deepEqual(lifecycleQueries, [{
      workspace_id: 'workspace-1',
      scope_type: 'target',
      target_id: 'cluster-1',
      target_type: 'kubernetes'
    }, {
      workspace_id: 'workspace-1',
      scope_type: 'target',
      target_id: 'target-1',
      target_type: 'virtual_machine'
    }]);
    assert(operations.indexOf('gateway:kubernetes') < operations.indexOf('local:kubernetes'));
    assert(operations.indexOf('gateway:virtual_machine') < operations.indexOf('local:virtual_machine'));
  });

  it('retains a VM locally after teardown failure and completes the retry', async () => {
    installWorkspace('admin');
    let teardownAttempts = 0;
    let localDeleteCount = 0;
    let disconnectCount = 0;
    mock.method(repo, 'deleteVirtualMachine', async () => {
      localDeleteCount += 1;
      return true;
    });
    mock.method(agentGateway, 'disconnectCluster', async () => {
      disconnectCount += 1;
    });
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method, 'DELETE');
      assert.equal(url.pathname, '/api/v1/internal/mcp/destinations');
      teardownAttempts += 1;
      return teardownAttempts === 1
        ? Response.json({ detail: {
            code: 'MCP_LIFECYCLE_TEARDOWN_FAILED',
            message: 'MCP lifecycle teardown did not complete; retry the request.',
            retryable: true
          } }, { status: 503 })
        : new Response(null, { status: 204 });
    });

    const failed = await callController(
      deleteVirtualMachine,
      createRequest({ workspaceId: 'workspace-1', vmId: 'target-1' })
    );
    assert.equal(failed.statusCode, 503);
    assert.equal((failed.body as { error: { code: string } }).error.code, 'MCP_LIFECYCLE_TEARDOWN_FAILED');
    assert.equal(localDeleteCount, 0);
    assert.equal(disconnectCount, 0);

    const retried = await callController(
      deleteVirtualMachine,
      createRequest({ workspaceId: 'workspace-1', vmId: 'target-1' })
    );
    assert.equal(retried.statusCode, 204);
    assert.equal(teardownAttempts, 2);
    assert.equal(localDeleteCount, 1);
    assert.equal(disconnectCount, 1);
  });
});
