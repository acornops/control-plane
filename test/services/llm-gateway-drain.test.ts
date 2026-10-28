import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, mock, test } from 'node:test';
import { config } from '../../src/config.js';
import { fetchGateway, LlmGatewayHttpError, parseGatewayResponse } from '../../src/services/llm-gateway-admin-client.js';
import { listWorkspaceProviderCredentials, putWorkspaceProviderCredential } from '../../src/services/llm-provider-credential-client.js';
import { listCatalogSources } from '../../src/services/mcp-catalog-client.js';
import { listTargetMcpTools, teardownWorkspaceMcpState } from '../../src/services/mcp-registry-client.js';

const originalConfig = {
  LLM_GATEWAY_TIMEOUT_MS: config.LLM_GATEWAY_TIMEOUT_MS,
  LLM_GATEWAY_URL: config.LLM_GATEWAY_URL,
  INTERNAL_TRANSPORT_TLS_ENABLED: config.INTERNAL_TRANSPORT_TLS_ENABLED
};
const draining = { error: { code: 'SERVICE_DRAINING', message: 'Service is draining', retryable: true, outcome: 'not_started' } };
const drainBody = JSON.stringify(draining);
const credentials = { workspace_id: 'workspace', providers: [] };

afterEach(() => {
  Object.assign(config, originalConfig);
  mock.restoreAll();
});

// Internal TLS returns this one-shot interface, without Response.clone().
function internalResponse(body: string | null, status = 200, headers: HeadersInit = {}) {
  const response = new Response(body, { status, headers });
  return {
    ok: response.ok, status, headers: response.headers, body: response.body,
    text: () => response.text(), json: () => response.json()
  };
}

test('provider credential GET recovers from exact drain without changing the authenticated request', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init });
    return requests.length === 1
      ? internalResponse(drainBody, 503)
      : internalResponse(JSON.stringify(credentials));
  });

  assert.deepEqual(await listWorkspaceProviderCredentials('workspace'), credentials);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].init.signal, requests[1].init.signal);
  for (const request of requests) {
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.redirect, 'error');
    assert.equal(new Headers(request.init.headers).get('authorization'), `Bearer ${config.LLM_GATEWAY_ADMIN_TOKEN}`);
  }
});

for (const [name, read, value] of [
  ['MCP tools', () => listTargetMcpTools('workspace', 'target', 'kubernetes'), []],
  ['catalog sources', () => listCatalogSources('workspace'), { items: [], capabilities: {} }]
] as const) {
  test(`${name} GET uses the same drain recovery`, async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? internalResponse(drainBody, 503) : internalResponse(JSON.stringify(value)));
    assert.deepEqual(await read(), value);
    assert.equal(calls, 2);
  });
}

for (const [name, status, body] of [
  ['other status', 500, drainBody],
  ['redirect', 307, drainBody],
  ['generic unavailable', 503, '{"detail":"gateway unavailable"}'],
  ['missing message', 503, JSON.stringify({ error: { code: 'SERVICE_DRAINING', retryable: true, outcome: 'not_started' } })],
  ['wrong message', 503, JSON.stringify({ error: { ...draining.error, message: 'Upstream is draining' } })],
  ['wrong code', 503, JSON.stringify({ error: { ...draining.error, code: 'UNAVAILABLE' } })],
  ['unknown outcome', 503, JSON.stringify({ error: { ...draining.error, outcome: 'unknown' } })],
  ['nonboolean retryable', 503, JSON.stringify({ error: { ...draining.error, retryable: 'true' } })],
  ['detail envelope', 503, JSON.stringify({ detail: draining.error })],
  ['invalid JSON', 503, 'temporarily unavailable']
] as const) {
  test(`GET does not retry ${name} and leaves the original error readable`, async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      return internalResponse(body, status, { 'retry-after': '9', 'x-request-id': 'request-1' });
    });
    const response = await fetchGateway('/read', { method: 'GET' });
    assert.equal(response.headers.get('x-request-id'), 'request-1');
    await assert.rejects(parseGatewayResponse(response), (error: LlmGatewayHttpError) => {
      assert.equal(error.status, status);
      assert.equal(error.responseBody, body);
      assert.equal(error.retryAfter, '9');
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
  test(`${method} is never replayed for a gateway drain response`, async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => { calls++; return internalResponse(drainBody, 503); });
    const response = await fetchGateway('/mutation', { method });
    assert.equal(await response.text(), drainBody);
    assert.equal(calls, 1);
  });
}

test('credential mutations keep their existing detail-string error parsing', async () => {
  const body = JSON.stringify({ detail: 'Credential cannot be changed', error: { message: 'other message' } });
  mock.method(globalThis, 'fetch', async () => internalResponse(body, 409));
  await assert.rejects(putWorkspaceProviderCredential('workspace', 'openai', 'test-key'), (error: LlmGatewayHttpError) => {
    assert.equal(error.message, 'Credential cannot be changed');
    assert.equal(error.responseBody, body);
    return true;
  });
});

test('transport errors are not retried, including after an exact drain rejection', async () => {
  for (const rejectAfterDrain of [false, true]) {
    let calls = 0;
    const failure = new Error('connection reset');
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (rejectAfterDrain && calls === 1) return internalResponse(drainBody, 503);
      throw failure;
    });
    await assert.rejects(fetchGateway('/read', { method: 'GET' }), (error) => error === failure);
    assert.equal(calls, rejectAfterDrain ? 2 : 1);
    mock.restoreAll();
  }
});

test('normal bodyless admin responses remain valid', async () => {
  for (const status of [204, 205, 304]) {
    mock.method(globalThis, 'fetch', async () => internalResponse(null, status, { 'x-request-id': 'empty' }));
    const response = await fetchGateway('/empty', { method: 'DELETE' });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('x-request-id'), 'empty');
    mock.restoreAll();
  }
  mock.method(globalThis, 'fetch', async () => internalResponse(null, 204));
  await teardownWorkspaceMcpState('workspace');
});

test('repeated drain responses consume one deadline and preserve the final 503', async () => {
  config.LLM_GATEWAY_TIMEOUT_MS = 350;
  let calls = 0;
  let signal: AbortSignal | undefined;
  mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    signal = init.signal;
    return internalResponse(drainBody, 503);
  });
  const started = performance.now();
  await assert.rejects(listWorkspaceProviderCredentials('workspace'), (error: LlmGatewayHttpError) => {
    assert.equal(error.status, 503);
    assert.equal(error.responseBody, drainBody);
    return true;
  });
  assert.equal(calls, 2);
  assert.ok(performance.now() - started >= 300);
  assert.ok(performance.now() - started < 1000);
  assert.equal(signal?.aborted, true);
});

for (const stage of ['before request', 'retry wait', 'body read'] as const) {
  test(`caller abort during ${stage} prevents further gateway attempts`, async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    let calls = 0;
    let releaseBody!: () => void;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (stage === 'body read') {
        const response = internalResponse(drainBody, 503);
        response.text = async () => {
          controller.abort(reason);
          await new Promise<void>((resolve) => { releaseBody = resolve; });
          return drainBody;
        };
        return response;
      }
      setTimeout(() => controller.abort(reason), 10);
      return internalResponse(drainBody, 503);
    });
    if (stage === 'before request') controller.abort(reason);
    const request = fetchGateway('/read', { method: 'GET', signal: controller.signal });
    try {
      await assert.rejects(request, (error) => error === reason);
    } finally { releaseBody?.(); }
    assert.equal(calls, stage === 'before request' ? 0 : 1);
  });
}

for (const status of [200, 503]) {
  test(`a real stalled ${status} response body cannot outlive the gateway deadline`, async () => {
    config.LLM_GATEWAY_TIMEOUT_MS = 40;
    config.INTERNAL_TRANSPORT_TLS_ENABLED = false;
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.write('{"error":');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    config.LLM_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
    const request = listWorkspaceProviderCredentials('workspace');
    try {
      const result = await Promise.race([
        request.then(() => 'resolved', () => 'rejected'),
        delay(200).then(() => 'unbounded')
      ]);
      assert.equal(result, 'rejected');
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await request.catch(() => undefined);
    }
  });
}
