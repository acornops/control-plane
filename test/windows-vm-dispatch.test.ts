import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import WebSocket from 'ws';
import { AgentGateway } from '../src/agent/ws-server.js';
import { setAgentConnection } from '../src/agent/connections.js';
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
function connect() {
  const ws = new FakeWebSocket();
  setAgentConnection('vm-1', { connectionId: 'conn', clusterId: 'vm-1', workspaceId: 'ws', targetType: 'virtual_machine', keyVersion: 1, ws: ws as unknown as WebSocket });
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
