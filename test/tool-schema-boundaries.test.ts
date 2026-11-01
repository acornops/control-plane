import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { repo } from '../src/store/repository.js';
import { resolveTargetRunTools } from '../src/services/target-run-tool-resolution.js';
import { syncTargetBuiltInTools } from '../src/services/target-built-in-tool-sync.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { restoreControllerRegressionState } from './helpers/controller-regression-fixtures.js';
import { BASE_TOOLS, installResolverRepoStubs, mockToolList } from './helpers/target-run-tool-resolution-fixtures.js';

afterEach(restoreControllerRegressionState);
beforeEach(() => {
  installResolverRepoStubs();
  // These schema-rejection cases require an existing VM before discovery/sync.
  mock.method(repo, 'getVirtualMachine', async () => ({
    id: 'target-1', workspaceId: 'workspace-1', name: 'Linux VM', status: 'online',
    osFamily: 'linux', serviceManager: 'systemd', allowedLogSources: ['journald'],
    agentAccessMode: 'read_only', restartServices: [], permissionMode: 'read_only',
    permissionModeOverride: null, permissionModeSource: 'deployment_default',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }));
});
const oversized = { enum: Array.from({ length: 101 }, (_, i) => i) };

it('rejects bootstrap rather than swallowing schema failure with populated authority lists', async () => {
  mockToolList(BASE_TOOLS.map(tool => ({ ...tool, input_schema: oversized })));
  await assert.rejects(resolveTargetRunTools({
    workspaceId: 'workspace-1', targetId: 'target-1', targetType: 'virtual_machine',
    toolAccessMode: 'read_write', includeNativeTools: false
  }), /TOOL_SCHEMA_REJECTED.*query_logs/);
});

it('disables only exact stale builtin registrations when advertised schemas are rejected', async () => {
  mock.method(agentGateway, 'listAgentTools', async () => ['bad-a', 'bad-b'].map(name => ({
    name, inputSchema: oversized, outputSchema: { type: 'object' }, artifactPolicy: 'never' as const
  })));
  const patches: Array<{ url: URL; body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/mcp/servers')) return new Response(JSON.stringify([
      { id: 'builtin-server', provenance_type: 'builtin' }
    ]));
    if (url.pathname.endsWith('/mcp/tools')) return new Response(JSON.stringify([
      { name: 'bad-a', server_id: 'builtin-server', source: 'builtin' },
      { name: 'bad-b', server_id: 'builtin-server', source: 'builtin' },
      { name: 'bad-a', server_id: 'other-server', source: 'mcp' }
    ]));
    if (init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ name: 'disabled' }));
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const result = await syncTargetBuiltInTools('workspace-1', 'target-1', 'virtual_machine');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /TOOL_SCHEMA_REJECTED/);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map(patch => patch.url.pathname.split('/').pop()).sort(), ['bad-a', 'bad-b']);
  for (const patch of patches) {
    assert.equal(patch.url.searchParams.get('server_id'), 'builtin-server');
    assert.equal(patch.url.searchParams.get('target_id'), 'target-1');
    assert.deepEqual(patch.body, { enabled: false });
  }
});

it('propagates schema rejection from initial builtin sync instead of bootstrapping without tools', async () => {
  mock.method(agentGateway, 'listAgentTools', async () => [{
    name: 'bad-new-tool', inputSchema: oversized, outputSchema: {}, artifactPolicy: 'never' as const
  }]);
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([])));
  await assert.rejects(resolveTargetRunTools({
    workspaceId: 'workspace-1', targetId: 'target-1', targetType: 'virtual_machine',
    toolAccessMode: 'read_only', includeNativeTools: false
  }), /TOOL_SCHEMA_REJECTED.*bad-new-tool/);
});

for (const failedStep of ['server lookup', 'tool lookup', 'disable patch']) {
  it(`keeps bootstrap rejected when schema cleanup fails at ${failedStep}`, async () => {
      mock.method(agentGateway, 'listAgentTools', async () => [{
      name: 'query_logs', inputSchema: oversized, outputSchema: {}, artifactPolicy: 'never' as const
    }]);
    const staleTool = { ...BASE_TOOLS.find(tool => tool.name === 'query_logs'), source: 'builtin', server_id: 'builtin-server' };
    let toolListings = 0;
    let cleanupFailed = false;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/mcp/tools')) {
        toolListings++;
        if (toolListings === 1) return new Response('Initial listing unavailable', { status: 503 });
        if (toolListings !== 2 || failedStep !== 'tool lookup') return new Response(JSON.stringify([staleTool]));
      } else if (url.pathname.endsWith('/mcp/servers')) {
        if (failedStep !== 'server lookup') return new Response(JSON.stringify([
          { id: 'builtin-server', provenance_type: 'builtin' }
        ]));
      } else if (init?.method !== 'PATCH') {
        throw new Error(`Unexpected request ${url}`);
      }
      cleanupFailed = true;
      return new Response('Registry cleanup unavailable', { status: 503 });
    });
    await assert.rejects(resolveTargetRunTools({
      workspaceId: 'workspace-1', targetId: 'target-1', targetType: 'virtual_machine',
      toolAccessMode: 'read_only', includeNativeTools: false
    }), /TOOL_SCHEMA_REJECTED.*query_logs/);
    assert.equal(cleanupFailed, true);
    assert.equal(toolListings, failedStep === 'server lookup' ? 1 : 2);
  });
}
