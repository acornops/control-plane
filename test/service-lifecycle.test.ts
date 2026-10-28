import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createServer, request } from 'node:http';
import { ServiceLifecycle, installHandlerTracking } from '../src/services/service-lifecycle.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

test('drain closes admission once and bounds waiting for accepted work', async () => {
  const lifecycle = new ServiceLifecycle();
  const done = deferred();
  const work = lifecycle.track(() => done.promise);
  const deadline = lifecycle.beginDrain(20);
  assert.equal(lifecycle.beginDrain(1000), deadline);
  assert.equal(lifecycle.accepting, false);
  assert.equal(await lifecycle.waitForIdle(deadline), false);
  done.resolve();
  await work;
  assert.equal(await lifecycle.waitForIdle(performance.now() + 100), true);
});

test('disconnect retains asynchronous handler work and draining rejects before effects', async () => {
  const lifecycle = new ServiceLifecycle();
  const app = express();
  app.use(lifecycle.admission);
  const started = deferred();
  const release = deferred();
  let completed = false;
  let effects = 0;
  app.post('/work', async (_req, res) => {
    effects++;
    started.resolve();
    await release.promise;
    completed = true;
    res.end('done');
  });
  installHandlerTracking(app, lifecycle);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const req = request({ host: '127.0.0.1', port, path: '/work', method: 'POST' });
  req.on('error', () => undefined);
  req.end();
  await started.promise;
  req.destroy();
  lifecycle.beginDrain(1000);
  const rejected = await fetch(`http://127.0.0.1:${port}/work`, { method: 'POST' });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get('retry-after'), '1');
  assert.deepEqual(await rejected.json(), { error: { code: 'SERVICE_DRAINING', message: 'Service is draining', retryable: true, outcome: 'not_started' } });
  assert.equal(effects, 1);
  assert.equal(await lifecycle.waitForIdle(performance.now() + 20), false);
  assert.equal(completed, false);
  release.resolve();
  assert.equal(await lifecycle.waitForIdle(performance.now() + 1000), true);
  assert.equal(completed, true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('nested router rejection reaches normal error middleware and remains tracked', async () => {
  const lifecycle = new ServiceLifecycle();
  const app = express();
  const router = express.Router();
  const release = deferred();
  router.get('/error', async () => { await release.promise; throw new Error('expected'); });
  app.use('/nested', router);
  app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(418).end(); });
  installHandlerTracking(app, lifecycle);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const response = fetch(`http://127.0.0.1:${port}/nested/error`);
  release.resolve();
  assert.equal((await response).status, 418);
  assert.equal(await lifecycle.waitForIdle(performance.now() + 100), true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('asynchronous error handlers remain retained until they settle', async () => {
  const lifecycle = new ServiceLifecycle();
  const app = express();
  const started = deferred();
  const release = deferred();
  app.get('/error', () => { throw new Error('expected'); });
  app.use(async (_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    started.resolve();
    await release.promise;
    res.status(418).end();
  });
  installHandlerTracking(app, lifecycle);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/error`);
  await started.promise;
  try { assert.equal(await lifecycle.waitForIdle(performance.now() + 20), false); }
  finally { release.resolve(); await response; await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('asynchronous router parameter callbacks remain retained after disconnect', async () => {
  const lifecycle = new ServiceLifecycle();
  const app = express();
  const started = deferred();
  const release = deferred();
  app.param('id', async (_req, _res, next) => { started.resolve(); await release.promise; next(); });
  app.get('/work/:id', (_req, res) => { res.end(); });
  installHandlerTracking(app, lifecycle);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const req = request({ host: '127.0.0.1', port: (server.address() as { port: number }).port, path: '/work/id' });
  req.on('error', () => undefined);
  req.end();
  await started.promise;
  req.destroy();
  try { assert.equal(await lifecycle.waitForIdle(performance.now() + 20), false); }
  finally { release.resolve(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('tracking preserves Express skip semantics for ordinary handlers with more than four arguments', async () => {
  const lifecycle = new ServiceLifecycle();
  const app = express();
  let called = false;
  app.use((function(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) { called = true; }) as unknown as express.RequestHandler);
  app.get('/ok', (_req, res) => { res.end('ok'); });
  installHandlerTracking(app, lifecycle);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/ok`, { signal: AbortSignal.timeout(300) });
    assert.equal(response.status, 200);
    assert.equal(called, false);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
