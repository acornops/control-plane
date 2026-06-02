import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { gatewayTokenService } from '../src/services/token-service.js';
import { repo } from '../src/store/repository.js';

const originalGetRun = repo.getRun;

afterEach(() => {
  repo.getRun = originalGetRun;
});

async function withTestServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

describe('internal service routing', () => {
  it('does not mount execution callbacks under the public api prefix', async () => {
    let getRunCalled = false;
    repo.getRun = async () => {
      getRunCalled = true;
      return null;
    };
    const headers = { Authorization: `Bearer ${config.ORCH_SERVICE_TOKEN}` };

    await withTestServer(async (baseUrl) => {
      const publicResponse = await fetch(`${baseUrl}/api/v1/runs/run-1/bootstrap`, {
        method: 'POST',
        headers
      });
      assert.equal(publicResponse.status, 404);
      assert.equal(getRunCalled, false);

      const internalResponse = await fetch(`${baseUrl}/internal/v1/runs/run-1/bootstrap`, {
        method: 'POST',
        headers
      });
      assert.equal(internalResponse.status, 404);
      assert.equal(getRunCalled, true);
    });
  });

  it('does not mount the builtin MCP bridge under the public api prefix', async () => {
    let getRunCalled = false;
    repo.getRun = async () => {
      getRunCalled = true;
      return null;
    };
    const orchHeaders = {
      Authorization: `Bearer ${config.ORCH_SERVICE_TOKEN}`,
      'content-type': 'application/json'
    };
    const runToken = await gatewayTokenService.signRunScopeToken({
      runId: 'run-1',
      workspaceId: 'ws-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      sessionId: 'session-1',
      allowedProviders: ['openai'],
      allowedTools: ['get_pods']
    });
    const runTokenHeaders = {
      Authorization: `Bearer ${runToken}`,
      'content-type': 'application/json'
    };

    await withTestServer(async (baseUrl) => {
      const publicResponse = await fetch(`${baseUrl}/api/v1/internal/mcp/tools/call`, {
        method: 'POST',
        headers: runTokenHeaders,
        body: JSON.stringify({ name: 'get_pods', arguments: {} })
      });
      assert.equal(publicResponse.status, 404);

      const orchTokenResponse = await fetch(`${baseUrl}/internal/v1/mcp/tools/call`, {
        method: 'POST',
        headers: orchHeaders,
        body: JSON.stringify({ name: 'get_pods', arguments: {} })
      });
      assert.equal(orchTokenResponse.status, 401);

      const internalResponse = await fetch(`${baseUrl}/internal/v1/mcp/tools/call`, {
        method: 'POST',
        headers: runTokenHeaders,
        body: JSON.stringify({ name: 'get_pods', arguments: {} })
      });
      assert.equal(internalResponse.status, 404);
      assert.equal(getRunCalled, true);
    });
  });

  it('does not accept the gateway run token on broader internal routes', async () => {
    let getRunCalled = false;
    repo.getRun = async () => {
      getRunCalled = true;
      return null;
    };
    const runToken = await gatewayTokenService.signRunScopeToken({
      runId: 'run-1',
      workspaceId: 'ws-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      sessionId: 'session-1',
      allowedProviders: ['openai'],
      allowedTools: ['get_pods']
    });
    const headers = { Authorization: `Bearer ${runToken}` };

    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/internal/v1/runs/run-1/bootstrap`, {
        method: 'POST',
        headers
      });

      assert.equal(response.status, 401);
      assert.equal(getRunCalled, false);
    });
  });

  it('does not expose parser exception details in global errors', async () => {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/auth/password/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-security-test'
        },
        body: '{"identifier":'
      });

      const body = await response.json() as {
        error: { code: string; message: string; retryable: boolean; request_id: string };
      };

      assert.equal(response.status, 500);
      assert.equal(response.headers.get('x-request-id'), 'req-security-test');
      assert.deepEqual(body, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          retryable: false,
          request_id: 'req-security-test'
        }
      });
    });
  });
});
