import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import WebSocket from 'ws';
import { agentGateway } from '../src/agent/ws-server.js';
import { resolvePendingAgentResponse, setAgentConnection } from '../src/agent/connections.js';
import type { AgentToolDefinition } from '../src/agent/types.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { syncTargetBuiltInTools } from '../src/services/target-built-in-tool-sync.js';
import { webhooks } from '../src/services/webhooks.js';
import { FakeWebSocket, installRedisStore, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

const previous = config.AGENTV_WINDOWS_ENABLED;
beforeEach(() => {
  setupControlPlaneCoordinationTest(); config.AGENTV_WINDOWS_ENABLED = true;
  mock.method(repo, 'getVirtualMachine', async (id: string) => ({ osFamily: id === 'windows' ? 'windows' : 'linux', serviceManager: id === 'windows' ? 'scm' : 'systemd' }) as Awaited<ReturnType<typeof repo.getVirtualMachine>>);
  mock.method(db, 'query', async () => ({ rowCount: 1, rows: [{ lifecycle_status: 'active' }] }));
  mock.method(webhooks, 'emit', () => undefined);
});
afterEach(() => { config.AGENTV_WINDOWS_ENABLED = previous; teardownControlPlaneCoordinationTest(); });
function definition(name: string, field: string, capability: 'read' | 'write' = 'read'): AgentToolDefinition {
  return { name, description: name, capability, version: '1.0.0',
    inputSchema: { type: 'object', additionalProperties: false, properties: { [field]: { type: 'string' } }, required: [field] },
    outputSchema: { type: 'object', additionalProperties: false, properties: { [field]: { type: 'string' } }, required: [field] }, artifactPolicy: 'if_detailed' };
}
it('keeps same-name Linux and Windows schemas in their own built-in destinations across sync and dispatch target switches', async () => {
  const catalogs = new Map<string, AgentToolDefinition[]>([
    ['linux', [definition('get_service', 'unit'), definition('query_logs', 'unit'), definition('restart_service', 'unit', 'write')]],
    ['windows', [definition('get_service', 'name'), definition('query_logs', 'channel'), definition('restart_service', 'name', 'write'), definition('arbitrary_shell', 'command', 'write'), definition('get_service', 'name', 'write')]]
  ]);
  const owners = new Map<string, string>();
  const sent: Array<{ targetId: string; method: string; params: Record<string, unknown> }> = [];
  for (const id of ['linux', 'windows']) {
    const ws = new FakeWebSocket();
    mock.method(ws, 'send', (data: unknown, callback?: (error?: Error) => void) => {
      const request = JSON.parse(String(data));
      sent.push({ targetId: id, method: request.method, params: request.params });
      resolvePendingAgentResponse(ws as unknown as WebSocket, { id: request.id, result: request.method === 'tools/list' ? { tools: catalogs.get(id) } : { ok: true } });
      callback?.();
    });
    setAgentConnection(id, { clusterId: id, workspaceId: 'workspace', connectionId: `conn-${id}`, keyVersion: 1, targetType: 'virtual_machine', ws: ws as unknown as WebSocket });
    owners.set(`cp:agent:owner:${id}`, JSON.stringify({ instanceId: config.CONTROL_PLANE_INSTANCE_ID, connectionId: `conn-${id}`, workspaceId: 'workspace', updatedAt: new Date().toISOString() }));
  }
  installRedisStore(owners);
  const registered = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.scope_type, 'target'); assert.equal(body.target_type, 'virtual_machine');
      registered.set(body.target_id, body);
      return Response.json({ id: `builtin-${body.target_id}`, server_name: 'builtin', tools: body.tools });
    }
    const targetId = url.searchParams.get('target_id')!;
    queries.push(targetId);
    assert.equal(url.searchParams.get('workspace_id'), 'workspace');
    assert.equal(url.searchParams.get('target_type'), 'virtual_machine');
    const current = registered.get(targetId);
    if (!current) return Response.json([]);
    if (url.pathname.endsWith('/servers')) return Response.json([{ id: `builtin-${targetId}`, provenance_type: 'builtin', enabled: true }]);
    return Response.json(current.tools);
  });
  for (const id of ['linux', 'windows', 'linux', 'windows']) {
    const result = await syncTargetBuiltInTools('workspace', id, 'virtual_machine');
    assert.equal(result.ok, true, result.error);
    const body = registered.get(id)!;
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.deepEqual((tools.find((tool) => tool.name === 'query_logs')!.input_schema as Record<string, unknown>).required, [id === 'windows' ? 'channel' : 'unit']);
    assert.deepEqual((tools.find((tool) => tool.name === 'get_service')!.input_schema as Record<string, unknown>).required, [id === 'windows' ? 'name' : 'unit']);
    for (const [name, field] of [['query_logs', id === 'windows' ? 'channel' : 'unit'], ['get_service', id === 'windows' ? 'name' : 'unit']]) {
      assert.deepEqual(tools.find((tool) => tool.name === name)!.output_schema, {
        type: 'object', additionalProperties: false, properties: { [field]: { type: 'string' } }, required: [field]
      });
    }
    assert.equal(tools.some((tool) => tool.capability === 'write'), id === 'linux');
    if (registered.has('linux') && registered.has('windows')) {
      const output = (targetId: string) => (registered.get(targetId)!.tools as Array<Record<string, unknown>>).find((tool) => tool.name === 'get_service')!.output_schema;
      assert.notDeepEqual(output('linux'), output('windows'));
    }
  }
  assert.deepEqual(queries, ['linux', 'linux', 'windows', 'windows', 'linux', 'linux', 'windows', 'windows']);
  for (const [id, args] of [['linux', { unit: 'backup.service' }], ['windows', { channel: 'System' }], ['linux', { unit: 'backup.service' }]] as const) {
    await agentGateway.sendJsonRpc(id, 'tools/call', { name: 'query_logs', arguments: args });
    assert.deepEqual(sent.at(-1), { targetId: id, method: 'tools/call', params: { name: 'query_logs', arguments: args } });
  }
  const before = sent.length;
  await assert.rejects(agentGateway.sendJsonRpc('windows', 'tools/call', { name: 'restart_service', arguments: { name: 'BackupEngine' } }), /reviewed read tools/);
  assert.equal(sent.length, before);
  await agentGateway.sendJsonRpc('linux', 'tools/call', { name: 'restart_service', arguments: { unit: 'backup.service' } });
  assert.equal(sent.at(-1)!.targetId, 'linux');
});
