import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { agentGateway } from '../src/agent/ws-server.js';
import { updateCluster } from '../src/controllers/workspaces/kubernetes-cluster-controller.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import type { KubernetesCluster } from '../src/types/domain.js';

afterEach(() => {
  mock.restoreAll();
});

function cluster(namespaceInclude: string[] = []): KubernetesCluster {
  return {
    id: 'cluster-1',
    workspaceId: 'workspace-1',
    name: 'cluster-1',
    status: 'online',
    namespaceInclude,
    namespaceExclude: [],
    permissionMode: 'auto_allowed_changes',
    permissionModeOverride: null,
    permissionModeSource: 'deployment_default',
    writeConfirmationRequiredOverride: null,
    writeConfirmationPolicy: {
      effectiveRequired: false,
      overrideRequired: null,
      source: 'deployment_default'
    },
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z'
  };
}

function request() {
  return {
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    },
    params: { workspaceId: 'workspace-1', clusterId: 'cluster-1' },
    body: { namespaceInclude: ['payments'], namespaceExclude: [] }
  };
}

function permissionModeRequest(permissionModeOverride: 'read_only' | 'ask_before_changes' | 'auto_allowed_changes' | null) {
  return {
    ...request(),
    body: { permissionModeOverride }
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

function installRepositoryMocks(): void {
  mock.method(repo, 'getWorkspaceRole', async () => 'admin');
  mock.method(repo, 'getCluster', async () => cluster());
  mock.method(repo, 'updateCluster', async () => cluster(['payments']));
  mock.method(repo, 'insertWorkspaceAuditEvent', async () => undefined);
  mock.method(webhooks, 'emit', () => undefined);
}

describe('Kubernetes namespace scope updates', () => {
  it('waits for a connected agent to apply the scope before responding', async () => {
    installRepositoryMocks();
    mock.method(agentGateway, 'isAgentConnected', async () => true);
    let acknowledge!: () => void;
    let started!: () => void;
    const updateStarted = new Promise<void>((resolve) => { started = resolve; });
    const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
    mock.method(agentGateway, 'updateNamespaceScope', async (_clusterId, scope) => {
      assert.deepEqual(scope, { include: ['payments'], exclude: [] });
      started();
      await acknowledgement;
      return {};
    });
    const res = response();

    const pending = updateCluster(request() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });
    await updateStarted;
    assert.equal(res.body, undefined);

    acknowledge();
    await pending;
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as KubernetesCluster).namespaceInclude, ['payments']);
  });

  it('persists the canonical cluster permission mode override', async () => {
    installRepositoryMocks();
    mock.method(agentGateway, 'isAgentConnected', async () => false);
    let updateInput: unknown;
    mock.method(repo, 'updateCluster', async (_clusterId, input) => {
      updateInput = input;
      return {
        ...cluster(),
        permissionMode: 'read_only',
        permissionModeOverride: 'read_only',
        permissionModeSource: 'cluster_override'
      };
    });
    const res = response();

    await updateCluster(permissionModeRequest('read_only') as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.deepEqual(updateInput, {
      name: undefined,
      namespaceInclude: undefined,
      namespaceExclude: undefined,
      permissionModeOverride: 'read_only'
    });
    assert.equal((res.body as KubernetesCluster).permissionMode, 'read_only');
  });

  it('disconnects a connected agent when applying the new scope fails', async () => {
    installRepositoryMocks();
    mock.method(agentGateway, 'isAgentConnected', async () => true);
    mock.method(agentGateway, 'updateNamespaceScope', async () => {
      throw new Error('scope update failed');
    });
    let disconnectReason = '';
    mock.method(agentGateway, 'disconnectCluster', async (_clusterId, reason) => {
      disconnectReason = reason;
      return true;
    });
    const res = response();

    await updateCluster(request() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.match(disconnectReason, /reconnect required/);
    assert.equal(res.statusCode, 200);
  });
});
