import assert from 'node:assert/strict';
import { once } from 'node:events';
import { it, mock } from 'node:test';
import express from 'express';
import { incrementAdminRequests, renderControlPlaneMetrics } from '../src/metrics.js';
import { adminRouter } from '../src/routes/admin.js';
import { adminAuthRouter } from '../src/routes/admin-auth.js';
import { redis } from '../src/infra/redis.js';

function requestMetrics(): string[] {
  return renderControlPlaneMetrics().split('\n').filter(line => line.startsWith('control_plane_admin_requests_total{'));
}

function count(method: string, route: string, status: string): number {
  const line = requestMetrics().find(line => line.includes(`method="${method}",route="${route}",status="${status}"`));
  return line ? Number(line.split('} ')[1]) : 0;
}

it('preserves nested route parameters and the HTTP status', () => {
  incrementAdminRequests('GET', '/workspaces/:workspaceId/members/:userId/role', 403);
  assert.equal(count('GET', '/workspaces/:workspaceId/members/:userId/role', '403'), 1);
});

it('bounds unknown paths, custom methods, and invalid statuses before storing counters', () => {
  const before = requestMetrics().length;
  for (let i = 0; i < 2_000; i++) {
    incrementAdminRequests('get', `/missing/${i}?secret=${i}`, 404);
    incrementAdminRequests(`CUSTOM${i}`, `/missing/${i}`, 600 + i);
  }
  for (const status of [NaN, Infinity, -1, 200.5]) incrementAdminRequests('PURGE', '/missing', status);
  assert.equal(requestMetrics().length - before, 2);
  assert.equal(count('GET', 'unmatched', '404'), 2_000);
  assert.equal(count('OTHER', 'unmatched', 'other'), 2_004);
  assert.doesNotMatch(requestMetrics().join('\n'), /secret|CUSTOM|missing/);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    incrementAdminRequests(method.toLowerCase(), '/me', 200);
    assert.equal(count(method, '/me', '200'), 1);
  }
  incrementAdminRequests('POST', '/me', 100);
  incrementAdminRequests('POST', '/me', 599);
  assert.equal(count('POST', '/me', '100'), 1);
  assert.equal(count('POST', '/me', '599'), 1);
});

it('counts real admin and admin-auth requests using safe templates and fallback labels', async () => {
  mock.method(redis, 'incr', async () => 1);
  mock.method(redis, 'expire', async () => 1);
  const app = express();
  app.use('/admin/v1', adminRouter);
  app.use('/admin-auth', adminAuthRouter);
  app.use((_req, res) => res.sendStatus(404));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const initialCount = count('GET', 'unmatched', '404');
    const initialSeries = requestMetrics().length;
    for (const prefix of ['/admin/v1', '/admin-auth']) {
      for (let i = 0; i < 100; i++) {
        const response = await fetch(`${origin}${prefix}/missing%20${i}?secret=${i}`);
        assert.equal(response.status, 404);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.arrayBuffer();
      }
    }
    assert.equal(count('GET', 'unmatched', '404') - initialCount, 200);
    assert.equal(requestMetrics().length, initialSeries);
    for (const method of ['PROPFIND', 'PURGE']) {
      const response = await fetch(`${origin}/admin/v1/unknown`, { method });
      assert.equal(response.status, 404);
      await response.arrayBuffer();
    }
    assert.equal(count('OTHER', 'unmatched', '404'), 2);
    for (const method of ['GET', 'HEAD', 'PATCH']) {
      const response = await fetch(`${origin}/admin/v1/workspaces/secret-id/members/secret-user/role`, { method });
      assert.equal(response.status, method === 'PATCH' ? 401 : 404);
      await response.arrayBuffer();
    }
    assert.equal(count('PATCH', '/workspaces/:workspaceId/members/:userId/role', '401'), 1);
    const logout = await fetch(`${origin}/admin-auth/logout`, { method: 'POST' });
    assert.equal(logout.status, 403);
    await logout.arrayBuffer();
    assert.equal(count('POST', '/admin-auth/logout', '403'), 1);
    const options = await fetch(`${origin}/admin/v1/me`, { method: 'OPTIONS' });
    assert.equal(options.status, 200);
    await options.arrayBuffer();
    assert.doesNotMatch(requestMetrics().join('\n'), /secret-id|secret-user|secret=|missing%20|unknown/);
  } finally {
    mock.restoreAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('keeps the finite metric vocabulary in sync with both routers', async () => {
  const { ADMIN_REQUEST_METRIC_ROUTE_LABELS } = await import('../src/metrics-admin-requests.js');
  const paths = (router: typeof adminRouter, prefix = ''): string[] =>
    router.stack.filter(layer => layer.route).map(layer => `${prefix}${layer.route.path}`);
  const declared = [...new Set([...paths(adminRouter), ...paths(adminAuthRouter, '/admin-auth')])].sort();
  assert.deepEqual([...ADMIN_REQUEST_METRIC_ROUTE_LABELS].sort(), declared);
});
