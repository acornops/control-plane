import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import WebSocket from 'ws';
import { AgentGateway } from '../src/agent/ws-server.js';
import { resolvePendingAgentResponse, setAgentConnection } from '../src/agent/connections.js';
import { config } from '../src/config.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import { filterVirtualMachineTools } from '../src/services/agentv-tool-policy.js';
import { syncTargetBuiltInTools } from '../src/services/target-built-in-tool-sync.js';
import type { AgentRpcRequest, AgentRpcResponse } from '../src/services/control-plane-coordination.js';
import { FakeWebSocket, installRedisStore, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

const originalEnabled = config.AGENTV_WINDOWS_ENABLED;
beforeEach(() => {
  setupControlPlaneCoordinationTest();
  config.AGENTV_WINDOWS_ENABLED = true;
  mock.method(webhooks, 'emit', () => undefined);
  mock.method(repo, 'getVirtualMachine', async () => ({ osFamily: 'windows', serviceManager: 'scm' }) as Awaited<ReturnType<typeof repo.getVirtualMachine>>);
});
afterEach(() => { config.AGENTV_WINDOWS_ENABLED = originalEnabled; teardownControlPlaneCoordinationTest(); });
const tools = ['get_host_summary', 'list_filesystems', 'list_processes', 'get_process', 'list_services', 'get_service', 'query_logs', 'list_listeners', 'restart_service', 'arbitrary_shell'].map((name) => ({ name, description: name, capability: 'read' as const, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, artifactPolicy: 'never' as const }));
function connect(targetType: 'virtual_machine' | 'kubernetes' = 'virtual_machine') {
  const ws = new FakeWebSocket();
  setAgentConnection('vm-1', { connectionId: 'conn', clusterId: 'vm-1', workspaceId: 'ws', targetType, keyVersion: 1, ws: ws as unknown as WebSocket });
  installRedisStore(new Map([['cp:agent:owner:vm-1', JSON.stringify({ instanceId: config.CONTROL_PLANE_INSTANCE_ID, connectionId: 'conn', workspaceId: 'ws', updatedAt: new Date().toISOString() })]]));
  return ws;
}
it('limits Windows discovery to exactly eight reviewed read tools, including a restart falsely marked read', async () => {
  const gateway = new AgentGateway();
  mock.method(gateway, 'sendJsonRpc', async () => ({ tools: [...tools, { ...tools[0], capability: 'write' }] }));
  assert.deepEqual((await gateway.listAgentTools('vm-1')).map((tool) => tool.name), tools.slice(0, 8).map((tool) => tool.name));
  config.AGENTV_WINDOWS_ENABLED = false;
  assert.deepEqual(await gateway.listAgentTools('vm-1'), []);
});
it('retains the Linux catalog and Windows target isolation', async () => {
  mock.method(repo, 'getVirtualMachine', async () => ({ osFamily: 'linux', serviceManager: 'systemd' }) as Awaited<ReturnType<typeof repo.getVirtualMachine>>);
  assert.deepEqual(await filterVirtualMachineTools('linux', tools), tools);
});
it('denies unknown and restart tools at the actual local and remote-owner dispatch boundaries', async () => {
  const ws = connect();
  const gateway = new AgentGateway();
  for (const name of ['restart_service', 'arbitrary_shell']) {
    await assert.rejects(gateway.sendJsonRpc('vm-1', 'tools/call', { name, arguments: {} }), /reviewed read tools/);
    const remote = await (gateway as unknown as { handleRemoteAgentRpc(request: AgentRpcRequest): Promise<AgentRpcResponse> }).handleRemoteAgentRpc({ requestId: name, clusterId: 'vm-1', expectedConnectionId: 'conn', originInstanceId: 'other', replyChannel: 'reply', method: 'tools/call', params: { name, arguments: {} } });
    assert.equal(remote.ok, false);
    assert.equal(remote.agentError?.data?.outcome, 'not_started');
  }
  config.AGENTV_WINDOWS_ENABLED = false;
  await assert.rejects(gateway.sendJsonRpc('vm-1', 'tools/call', { name: 'query_logs' }), /reviewed read tools/);
  assert.deepEqual(ws.sent, []);
});
it('filters unsafe Windows tools at built-in synchronization even with independent discovery', async () => {
  const { agentGateway } = await import('../src/agent/ws-server.js');
  mock.method(agentGateway, 'listAgentTools', async () => tools);
  let registeredNames: string[] = [];
  mock.method(globalThis, 'fetch', async (input, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { tools: Array<{ name: string }> };
      registeredNames = body.tools.map((tool) => tool.name);
      return new Response(JSON.stringify({ server_name: 'builtin', tools: body.tools }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  const result = await syncTargetBuiltInTools('ws', 'vm-1', 'virtual_machine');
  assert.equal(result.ok, true);
  assert.deepEqual(registeredNames, tools.slice(0, 8).map((tool) => tool.name));
});

it('rejects deleted-target discovery instead of exposing a stale Windows catalog', async () => {
  const { AgentToolCallError } = await import('../src/agent/types.js');
  mock.method(repo, 'getVirtualMachine', async () => null);
  mock.method(repo, 'getTargetById', async () => null);
  const gateway = new AgentGateway();
  mock.method(gateway, 'sendJsonRpc', async () => ({ tools }));
  await assert.rejects(gateway.listAgentTools('vm-1'), (error: unknown) => error instanceof AgentToolCallError && error.data?.outcome === 'not_started');
});

for (const route of ['local', 'remote'] as const) {
  for (const method of ['tools/call', 'tools/list'] as const) {
    it(`rejects deleted VM ${method} at ${route} owner dispatch without sending to its retained socket`, async () => {
      const { db } = await import('../src/infra/db.js');
      const { AgentToolCallError } = await import('../src/agent/types.js');
      const ws = connect();
      mock.method(repo, 'getVirtualMachine', async () => null);
      mock.method(repo, 'getTargetById', async () => null);
      mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{ lifecycle_status: 'active' }] }));
      const send = mock.method(ws, 'send', () => { throw new Error('Deleted-target request reached socket'); });
      const gateway = new AgentGateway();
      if (route === 'local') {
        await assert.rejects(method === 'tools/list' ? gateway.listAgentTools('vm-1') : gateway.sendJsonRpc('vm-1', method, { name: 'restart_service' }), (error: unknown) => error instanceof AgentToolCallError && error.data?.outcome === 'not_started');
      } else {
        const response = await (gateway as unknown as { handleRemoteAgentRpc(request: AgentRpcRequest): Promise<AgentRpcResponse> }).handleRemoteAgentRpc({ requestId: 'deleted', clusterId: 'vm-1', expectedConnectionId: 'conn', originInstanceId: 'other', replyChannel: 'reply', method, params: { name: 'restart_service' } });
        assert.equal(response.ok, false);
        assert.equal(response.agentError?.data?.outcome, 'not_started');
      }
      assert.equal(send.mock.callCount(), 0);
    });
  }
}

it('keeps existing Kubernetes discovery separate from a missing VM', async () => {
  mock.method(repo, 'getVirtualMachine', async () => null);
  mock.method(repo, 'getTargetById', async () => ({ targetType: 'kubernetes' }) as Awaited<ReturnType<typeof repo.getTargetById>>);
  const gateway = new AgentGateway();
  mock.method(gateway, 'sendJsonRpc', async () => ({ tools }));
  assert.deepEqual(await gateway.listAgentTools('cluster-1'), tools);
});

for (const targetType of ['virtual_machine', 'kubernetes'] as const) {
  it(`preserves existing ${targetType} local and remote owner dispatch`, async () => {
    const { db } = await import('../src/infra/db.js');
    const vmLookup = mock.method(repo, 'getVirtualMachine', async () => ({ osFamily: 'linux', serviceManager: 'systemd' }) as Awaited<ReturnType<typeof repo.getVirtualMachine>>);
    mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{ lifecycle_status: 'active' }] }));
    const ws = connect(targetType);
    const send = mock.method(ws, 'send', (data: unknown, cb?: (error?: Error) => void) => {
      const request = JSON.parse(String(data)) as { id: string };
      resolvePendingAgentResponse(ws as unknown as WebSocket, { id: request.id, result: { ok: true } });
      cb?.();
    });
    const gateway = new AgentGateway();
    assert.deepEqual(await gateway.sendJsonRpc('vm-1', 'tools/call', { name: 'restart_service' }), { ok: true });
    const response = await (gateway as unknown as { handleRemoteAgentRpc(request: AgentRpcRequest): Promise<AgentRpcResponse> }).handleRemoteAgentRpc({ requestId: 'existing', clusterId: 'vm-1', expectedConnectionId: 'conn', originInstanceId: 'other', replyChannel: 'reply', method: 'tools/call', params: { name: 'restart_service' } });
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { ok: true });
    assert.equal(send.mock.callCount(), 2);
    assert.equal(vmLookup.mock.callCount(), targetType === 'kubernetes' ? 0 : 2);
  });
}
