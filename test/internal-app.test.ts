import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInternalApp } from '../src/internal-app.js';

function routeExists(app: ReturnType<typeof createInternalApp>, path: string): boolean {
  const stack = ((app as unknown as { router?: { stack?: Array<{ route?: { path: string } }> } }).router?.stack || []);
  return stack.some((layer) => layer.route?.path === path);
}

describe('createInternalApp', () => {
  it('exposes health and internal routes but not public workspace APIs', async () => {
    const app = createInternalApp();

    assert.equal(routeExists(app, '/health'), true);
    assert.equal(routeExists(app, '/api/v1/workspaces'), false);
  });
});
