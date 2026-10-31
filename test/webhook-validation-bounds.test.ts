import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { webhooksRouter } from '../src/routes/webhooks.js';
import { repo } from '../src/store/repository.js';
import { createWebhookSubscriptionSchema, updateWebhookSubscriptionSchema, webhookEventTypes } from '../src/types/webhook-contracts.js';

afterEach(() => mock.restoreAll());

const valid = { name: 'Events', url: 'https://example.test/hook', eventTypes: [...webhookEventTypes] };

// Exercise the actual route chain after its unchanged user-authentication middleware.
function dispatch(method: 'post' | 'patch', body: unknown): Promise<{ statusCode: number; body: any }> {
  const path = method === 'post' ? '/workspaces/:workspaceId/webhooks' : '/workspaces/:workspaceId/webhooks/:webhookId';
  const route = webhooksRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  const handlers = route.stack.slice(1);
  const req = { auth: { userId: 'user-1' }, params: { workspaceId: 'workspace-1', webhookId: 'hook-1' }, body };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { resolve({ statusCode: this.statusCode, body: value }); return this; }
    };
    let index = 0;
    function next(err?: unknown) {
      if (err) { reject(err); return; }
      const handler = handlers[index++];
      if (!handler) { reject(new Error('No response')); return; }
      try { Promise.resolve(handler.handle(req, res, next)).catch(reject); } catch (error) { reject(error); }
    }
    next();
  });
}

for (const [name, schema] of [['create', createWebhookSubscriptionSchema], ['update', updateWebhookSubscriptionSchema]] as const) {
  it(`${name} rejects excessive event types before reading array elements`, () => {
    const items = Array(webhookEventTypes.length + 1).fill(null);
    let reads = 0;
    items.forEach((_, i) => Object.defineProperty(items, i, { get() { reads++; return null; } }));
    const result = schema.safeParse({ ...valid, eventTypes: items });
    assert.equal(result.success, false);
    assert.equal(reads, 0);
    if (!result.success) assert.equal(result.error.issues.length, 1);
  });
}

for (const method of ['post', 'patch'] as const) {
  it(`${method} authorizes before inspecting an invalid request body`, async () => {
    mock.method(repo, 'getWorkspaceRole', async () => 'viewer');
    const body = { get eventTypes(): never { throw new Error('Unauthorized body was inspected'); } };
    const response = await dispatch(method, body);
    assert.equal(response.statusCode, 403);
  });

  it(`${method} returns bounded validation errors without persisting invalid definitions`, async () => {
    mock.method(repo, 'getWorkspaceRole', async () => 'admin');
    mock.method(repo, 'createWebhookSubscription', async () => { throw new Error('Invalid definition persisted'); });
    mock.method(repo, 'updateWebhookSubscription', async () => { throw new Error('Invalid definition persisted'); });
    const response = await dispatch(method, { ...valid, eventTypes: Array(5000).fill('invalid') });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 1024);
    const unknownKey = 'x'.repeat(10000);
    const unknown = await dispatch(method, { ...valid, [unknownKey]: true });
    assert.equal(unknown.statusCode, 400);
    assert.ok(Buffer.byteLength(JSON.stringify(unknown.body)) < 1024);
  });
}

it('preserves the full supported catalog and partial update omission', async () => {
  assert.deepEqual(createWebhookSubscriptionSchema.parse(valid), valid);
  assert.deepEqual(updateWebhookSubscriptionSchema.parse({ enabled: false }), { enabled: false });
  mock.method(repo, 'getWorkspaceRole', async () => 'admin');
  let patch: unknown;
  mock.method(repo, 'updateWebhookSubscription', async (_workspaceId, _id, input) => {
    patch = input;
    return { id: 'hook-1', workspaceId: 'workspace-1', ...valid, enabled: false, createdBy: 'user-1' };
  });
  const response = await dispatch('patch', { enabled: false });
  assert.equal(response.statusCode, 200);
  assert.equal((patch as { enabled: boolean }).enabled, false);
  assert.equal(Object.hasOwn(patch as object, 'targetId'), false);
});
