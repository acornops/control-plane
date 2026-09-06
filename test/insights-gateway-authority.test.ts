import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { streamGatewayJsonPatch } from '../src/services/target-insights/checkpoint-gateway.js';
import { gatewayTokenService } from '../src/services/token-service.js';

afterEach(() => mock.restoreAll());
test('Insights forwards its granted owner and generation with the persisted run identity', async () => {
  mock.method(gatewayTokenService, 'signRunScopeToken', async claims => {
    assert.equal(claims.runId, 'persisted-attempt');
    return 'scoped-test-token';
  });
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped-test-token');
    assert.equal(headers.get('x-acornops-execution-owner'), 'insights-lease-owner');
    assert.equal(headers.get('x-acornops-execution-generation'), '7');
    assert.equal(JSON.parse(String(init?.body)).run_id, 'persisted-attempt');
    return new Response('{"type":"delta","text":"{}"}\n{"type":"final","usage":{}}\n');
  });
  const result = await streamGatewayJsonPatch({
    execution: { runId: 'persisted-attempt', ownerId: 'insights-lease-owner', generation: 7, workspaceId: 'workspace-1' },
    workspaceId: 'workspace-1', targetId: 'target-1', targetType: 'kubernetes', sessionId: 'session-1',
    provider: 'openai', model: 'model', allowedProviders: ['openai'], allowedModels: ['model'],
    transcript: 'Supported evidence', existingEntries: []
  });
  assert.equal(result, '{}');
});
