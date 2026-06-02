import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { requireAdminScope, hashAdminToken } from '../src/auth/admin-token.js';
import { config, parseAdminTokenDescriptors, parseAppConfig } from '../src/config.js';
import { redis } from '../src/infra/redis.js';
import { createApp } from '../src/app.js';
import { adminRouter } from '../src/routes/admin.js';

const mutableConfig = config as typeof config & {
  CONTROL_PLANE_ADMIN_API_ENABLED: boolean;
  ADMIN_TOKEN_DESCRIPTORS: typeof config.ADMIN_TOKEN_DESCRIPTORS;
};

const originalAdminEnabled = config.CONTROL_PLANE_ADMIN_API_ENABLED;
const originalDescriptors = config.ADMIN_TOKEN_DESCRIPTORS;

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    locals: { requestId: 'req-test' },
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

function hasAdminRouterMount(): boolean {
  const app = createApp() as ReturnType<typeof createApp> & {
    router?: { stack?: Array<{ handle?: unknown }> };
  };
  return app.router?.stack?.some((layer) => layer.handle === adminRouter) ?? false;
}

function firstAdminRouterMiddleware() {
  return (adminRouter as unknown as { stack: Array<{ handle: (req: unknown, res: unknown, next: () => void) => void }> }).stack[0].handle;
}

describe('admin token configuration and middleware', () => {
  afterEach(() => {
    mutableConfig.CONTROL_PLANE_ADMIN_API_ENABLED = originalAdminEnabled;
    mutableConfig.ADMIN_TOKEN_DESCRIPTORS = originalDescriptors;
    mock.restoreAll();
  });

  it('parses hash descriptors and rejects production enablement without tokens', () => {
    const descriptors = parseAdminTokenDescriptors(JSON.stringify([
      {
        id: 'ops-primary',
        sha256: hashAdminToken('raw-admin-token'),
        scopes: ['admin:self'],
        enabled: true
      }
    ]));

    assert.equal(descriptors[0].id, 'ops-primary');
    assert.equal(descriptors[0].scopes[0], 'admin:self');
    assert.throws(() => parseAdminTokenDescriptors(JSON.stringify([
      { id: 'ops-primary', sha256: hashAdminToken('raw-admin-token'), scopes: ['admin:self'] },
      { id: 'ops-secondary', sha256: hashAdminToken('raw-admin-token'), scopes: ['admin:workspace:write'] }
    ])), /Duplicate admin token descriptor hash/);
    assert.throws(() => parseAppConfig({ CONTROL_PLANE_ADMIN_API_ENABLED: 'true' }), /CONTROL_PLANE_ADMIN_TOKENS_JSON/);
  });

  it('authenticates only scoped admin bearer tokens', async () => {
    mock.method(redis, 'incr', async () => 1);
    mock.method(redis, 'expire', async () => 1);
    mutableConfig.ADMIN_TOKEN_DESCRIPTORS = [
      {
        id: 'ops-primary',
        sha256: hashAdminToken('raw-admin-token'),
        scopes: ['admin:self'],
        enabled: true
      }
    ];
    const middleware = requireAdminScope('admin:self');
    const req = {
      header: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer raw-admin-token' : undefined,
      ip: '127.0.0.1',
      socket: {}
    };
    const res = createResponse();
    let nextCalled = false;

    await middleware(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual((req as { admin?: unknown }).admin, {
      tokenId: 'ops-primary',
      scopes: ['admin:self'],
      credential: { type: 'admin_token' }
    });
  });

  it('rejects browser cookies, service tokens, run JWTs, and missing scopes', async () => {
    mock.method(redis, 'incr', async () => 1);
    mock.method(redis, 'expire', async () => 1);
    mutableConfig.ADMIN_TOKEN_DESCRIPTORS = [
      {
        id: 'ops-primary',
        sha256: hashAdminToken('raw-admin-token'),
        scopes: ['admin:self'],
        enabled: true
      }
    ];

    const cookieReq = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' },
      header: () => undefined,
      ip: '127.0.0.1',
      socket: {}
    };
    const cookieRes = createResponse();
    await requireAdminScope('admin:self')(cookieReq as never, cookieRes as never, () => undefined);
    assert.equal(cookieRes.statusCode, 401);

    const malformedReq = {
      header: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer raw admin-token' : undefined,
      ip: '127.0.0.1',
      socket: {}
    };
    const malformedRes = createResponse();
    await requireAdminScope('admin:self')(malformedReq as never, malformedRes as never, () => undefined);
    assert.equal(malformedRes.statusCode, 401);

    for (const token of [
      config.ORCH_SERVICE_TOKEN,
      config.EXECUTION_ENGINE_DISPATCH_TOKEN,
      config.LLM_GATEWAY_ADMIN_TOKEN,
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJydW4ifQ.signature'
    ]) {
      const serviceReq = {
        header: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
        ip: '127.0.0.1',
        socket: {}
      };
      const serviceRes = createResponse();
      await requireAdminScope('admin:self')(serviceReq as never, serviceRes as never, () => undefined);
      assert.equal(serviceRes.statusCode, 401);
    }

    const scopedReq = {
      header: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer raw-admin-token' : undefined,
      ip: '127.0.0.1',
      socket: {}
    };
    const scopedRes = createResponse();
    await requireAdminScope('admin:workspace:write')(scopedReq as never, scopedRes as never, () => undefined);
    assert.equal(scopedRes.statusCode, 403);
  });

  it('rate-limits repeated failed admin authentication by source', async () => {
    mock.method(redis, 'incr', async () => config.CONTROL_PLANE_ADMIN_AUTH_FAILURE_MAX_ATTEMPTS + 1);
    mock.method(redis, 'expire', async () => 1);
    const req = {
      header: () => undefined,
      ip: '127.0.0.1',
      socket: {}
    };
    const res = createResponse();

    await requireAdminScope('admin:self')(req as never, res as never, () => undefined);

    assert.equal(res.statusCode, 429);
  });

  it('mounts /admin/v1 only when enabled', async () => {
    mutableConfig.ADMIN_TOKEN_DESCRIPTORS = [
      {
        id: 'ops-primary',
        sha256: hashAdminToken('raw-admin-token'),
        scopes: ['admin:self'],
        enabled: true
      }
    ];
    mutableConfig.CONTROL_PLANE_ADMIN_API_ENABLED = false;
    assert.equal(hasAdminRouterMount(), false);

    mutableConfig.CONTROL_PLANE_ADMIN_API_ENABLED = true;
    assert.equal(hasAdminRouterMount(), true);
  });

  it('marks all admin responses as no-store', async () => {
    const headers = new Map<string, string>();
    let nextCalled = false;
    const req = { method: 'GET', path: '/me', route: undefined };
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      on() {
        return this;
      },
      statusCode: 200
    };

    firstAdminRouterMiddleware()(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(headers.get('cache-control'), 'no-store');
  });
});
