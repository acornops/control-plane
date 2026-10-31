import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { Router } from 'express';
import * as controllers from '../src/controllers/workspaces-controller.js';
import { getVirtualMachineLogs } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { registerVirtualMachineRoutes } from '../src/routes/workspaces/virtual-machine-routes.js';
import { config } from '../src/config.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { repo } from '../src/store/repository.js';
import { webhooks } from '../src/services/webhooks.js';
import { buildVirtualMachinePaths } from '../src/docs/openapi/virtual-machine-paths.js';

const previous = { enabled: config.AGENTV_WINDOWS_ENABLED, version: config.AGENTV_WINDOWS_RELEASE_VERSION, url: config.AGENTV_WINDOWS_RELEASE_BASE_URL };
beforeEach(() => {
  mock.method(repo, 'getWorkspaceRole', async () => 'owner');
  mock.method(repo, 'getTarget', async () => ({ id: 'vm', workspaceId: 'ws', targetType: 'virtual_machine', metadata: { osFamily: 'windows', serviceManager: 'scm' } }) as Awaited<ReturnType<typeof repo.getTarget>>);
  mock.method(repo, 'insertWorkspaceAuditEvent', async () => undefined);
  mock.method(webhooks, 'emit', () => undefined);
});
afterEach(() => {
  config.AGENTV_WINDOWS_ENABLED = previous.enabled;
  config.AGENTV_WINDOWS_RELEASE_VERSION = previous.version;
  config.AGENTV_WINDOWS_RELEASE_BASE_URL = previous.url;
  mock.restoreAll();
});
function request(query: Record<string, unknown> = {}) {
  return { auth: { userId: 'user', credential: { type: 'session', sessionId: 'session' } }, params: { workspaceId: 'ws', vmId: 'vm' }, query };
}
function response() {
  return { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(key: string, value: string) { this.headers[key] = value; return this; } };
}
const next = (error?: unknown) => { if (error) throw error; };
async function options() {
  const handler = (controllers as unknown as Record<string, typeof getVirtualMachineLogs>).getVirtualMachineRegistrationOptions;
  assert.equal(typeof handler, 'function', 'registration-options handler must exist');
  const res = response();
  await handler(request() as never, res as never, next);
  return res;
}
const linux = { osFamily: 'linux', serviceManager: 'systemd', accessModes: ['read_only', 'read_write'] };
const windows = { osFamily: 'windows', serviceManager: 'scm', accessModes: ['read_only'] };
it('returns exactly Linux registration options with Windows disabled or unqualified', async () => {
  for (const enabled of [false, true]) {
    config.AGENTV_WINDOWS_ENABLED = enabled;
    config.AGENTV_WINDOWS_RELEASE_VERSION = undefined;
    config.AGENTV_WINDOWS_RELEASE_BASE_URL = undefined;
    assert.deepEqual((await options()).body, { platforms: [linux] });
  }
});
it('adds Windows registration options only with valid enabled release coordinates and exposes no configuration secrets', async () => {
  config.AGENTV_WINDOWS_ENABLED = true;
  config.AGENTV_WINDOWS_RELEASE_VERSION = '1.2.3';
  config.AGENTV_WINDOWS_RELEASE_BASE_URL = 'https://releases.secret.test';
  const res = await options();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { platforms: [linux, windows] });
  assert.doesNotMatch(JSON.stringify(res.body), /https:|1.2.3|token|secret/);
  config.AGENTV_WINDOWS_RELEASE_BASE_URL = 'http://invalid.test';
  assert.deepEqual((await options()).body, { platforms: [linux] });
});
it('denies registration options to users without target management permission', async () => {
  mock.method(repo, 'getWorkspaceRole', async () => 'viewer');
  assert.equal((await options()).statusCode, 403);
});
it('registers the authenticated user-only options route before the VM detail route', async () => {
  const router = Router();
  registerVirtualMachineRoutes(router);
  const routes = router.stack.map((layer) => layer.route).filter(Boolean);
  const index = routes.findIndex((route) => route.path === '/workspaces/:workspaceId/virtual-machines/registration-options');
  assert.ok(index >= 0);
  assert.ok(index < routes.findIndex((route) => route.path === '/workspaces/:workspaceId/virtual-machines/:vmId'));
  const res = response();
  await routes[index].stack[0].handle({ cookies: {}, header: () => undefined }, res, next);
  assert.equal(res.statusCode, 401);
});
it('documents the exact registration-options response with session authentication', () => {
  const path = buildVirtualMachinePaths()['/api/v1/workspaces/{workspaceId}/virtual-machines/registration-options'] as { get?: { security: unknown; responses: Record<string, unknown> } };
  assert.ok(path?.get);
  assert.deepEqual(path.get.security, [{ userSession: [] }]);
  assert.match(JSON.stringify(path.get.responses['200']), /platforms/);
});
it('routes bounded Windows logs using a native channel, timestamps and literal query', async () => {
  const call = mock.method(agentGateway, 'callAgentTool', async () => ({ entries: [] }));
  const res = response();
  await getVirtualMachineLogs(request({ channel: 'System', q: 'literal message', since: '2026-10-30T00:00:00Z', until: '2026-10-30T01:00:00Z', tailLines: '20', limitBytes: '2048' }) as never, res as never, next);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(call.mock.calls[0].arguments, ['vm', 'query_logs', { channel: 'System', query: 'literal message', since: '2026-10-30T00:00:00Z', until: '2026-10-30T01:00:00Z', limit: 20, byte_limit: 2048 }]);
});
for (const query of [{}, { channel: 'Security' }, { channel: 'System', unit: 'nginx.service' }, { channel: 'System', source: 'journald' }, { channel: 'System', since: 'invalid' }, { channel: 'System', q: 'x'.repeat(257) }]) {
  it(`rejects invalid native Windows log query ${JSON.stringify(query).slice(0, 70)} before dispatch`, async () => {
    const call = mock.method(agentGateway, 'callAgentTool', async () => ({}));
    const res = response();
    await getVirtualMachineLogs(request(query) as never, res as never, next);
    assert.equal(res.statusCode, 400);
    assert.equal(call.mock.callCount(), 0);
  });
}
it('retains exact legacy Linux unit routing and does not require new platform metadata', async () => {
  mock.method(repo, 'getTarget', async () => ({ id: 'vm', workspaceId: 'ws', targetType: 'virtual_machine', metadata: {} }) as Awaited<ReturnType<typeof repo.getTarget>>);
  const call = mock.method(agentGateway, 'callAgentTool', async () => ({}));
  const res = response();
  await getVirtualMachineLogs(request({ source: 'journald', unit: 'nginx.service', q: 'failed' }) as never, res as never, next);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(call.mock.calls[0].arguments, ['vm', 'query_logs', { unit: 'nginx.service', query: 'failed', limit: 200, byte_limit: 1048576 }]);
});
it('checks Windows log permissions before calling the agent', async () => {
  mock.method(repo, 'getWorkspaceRole', async () => 'viewer');
  const call = mock.method(agentGateway, 'callAgentTool', async () => ({}));
  const res = response();
  await getVirtualMachineLogs(request({ channel: 'Application' }) as never, res as never, next);
  assert.equal(res.statusCode, 403);
  assert.equal(call.mock.callCount(), 0);
});

for (const status of ['permission_denied', 'unavailable', 'partial']) {
  it(`preserves successful native log ${status} envelopes through HTTP 200`, async () => {
    const payload = { entries: status === 'partial' ? [{ channel: 'System', message: 'retained event' }] : [],
      health: { collector: 'windows_events', status, duration_ms: 2 }, truncated: true,
      returned_count: status === 'partial' ? 1 : 0, original_count: 2, byte_count: 100 };
    mock.method(agentGateway, 'callAgentTool', async () => payload);
    const res = response();
    await getVirtualMachineLogs(request({ channel: 'System' }) as never, res as never, next);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, payload);
  });
}
