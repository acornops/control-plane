import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import { createInternalApp } from '../src/internal-app.js';
import { adminAuthRouter } from '../src/routes/admin-auth.js';
import { adminRouter } from '../src/routes/admin.js';

const mutableConfig = config as typeof config & {
  CONTROL_PLANE_ADMIN_API_ENABLED: boolean;
  CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED: boolean;
};
const originalAdminEnabled = config.CONTROL_PLANE_ADMIN_API_ENABLED;
const originalHumanAuthRequired = config.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED;

function routeExists(app: ReturnType<typeof createInternalApp>, path: string): boolean {
  const stack = ((app as unknown as { router?: { stack?: Array<{ route?: { path: string } }> } }).router?.stack || []);
  return stack.some((layer) => layer.route?.path === path);
}

function routerMounted(app: ReturnType<typeof createInternalApp>, router: unknown): boolean {
  const stack = ((app as unknown as { router?: { stack?: Array<{ handle?: unknown }> } }).router?.stack || []);
  return stack.some((layer) => layer.handle === router);
}

describe('createInternalApp', () => {
  afterEach(() => {
    mutableConfig.CONTROL_PLANE_ADMIN_API_ENABLED = originalAdminEnabled;
    mutableConfig.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED = originalHumanAuthRequired;
  });

  it('exposes health and internal routes but not public workspace APIs', async () => {
    const app = createInternalApp();

    assert.equal(routeExists(app, '/health'), true);
    assert.equal(routeExists(app, '/api/v1/workspaces'), false);
  });

  it('exposes admin API and human auth routes on the mTLS app when enabled', () => {
    mutableConfig.CONTROL_PLANE_ADMIN_API_ENABLED = true;
    mutableConfig.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED = true;
    const app = createInternalApp();

    assert.equal(routerMounted(app, adminRouter), true);
    assert.equal(routerMounted(app, adminAuthRouter), true);
  });

  it('does not expose admin routes on the mTLS app when disabled', () => {
    mutableConfig.CONTROL_PLANE_ADMIN_API_ENABLED = false;
    mutableConfig.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED = true;
    const app = createInternalApp();

    assert.equal(routerMounted(app, adminRouter), false);
    assert.equal(routerMounted(app, adminAuthRouter), false);
  });
});
