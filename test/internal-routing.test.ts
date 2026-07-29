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
  it('mounts automatic MCP OAuth while keeping retired credential routes absent', async () => {
    const connectionBases = [
      '/api/v1/workspaces/ws-1/targets/target-1/mcp/servers/server-1/connection',
      '/api/v1/workspaces/ws-1/agents/agent-1/mcp/servers/server-1/connection'
    ];
    const removedSuffixes = [
      '/oauth/complete',
      '/oauth/client-credentials',
      '/service-connection'
    ];

    await withTestServer(async (baseUrl) => {
      for (const connectionBase of connectionBases) {
        for (const suffix of ['/oauth/prepare', '/oauth/start']) {
          const response = await fetch(`${baseUrl}${connectionBase}${suffix}`, { method: 'POST' });
          assert.equal(response.status, 401, `${connectionBase}${suffix}`);
        }
        for (const suffix of removedSuffixes) {
          const response = await fetch(`${baseUrl}${connectionBase}${suffix}`, { method: 'POST' });
          assert.equal(response.status, 404, `${connectionBase}${suffix}`);
        }
      }

      const callback = await fetch(
        `${baseUrl}/api/v1/mcp/oauth/callback?state=${'a'.repeat(43)}&code=code`,
        { redirect: 'manual' }
      );
      assert.equal(callback.status, 303);
      const callbackLocation = new URL(callback.headers.get('location') || '');
      assert.equal(callbackLocation.origin, new URL(config.MANAGEMENT_CONSOLE_BASE_URL).origin);
      assert.equal(
        callbackLocation.searchParams.get('mcpOAuthResult'),
        'MCP_OAUTH_SESSION_REQUIRED'
      );
    });
  });

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
      principal: { type: 'user', id: 'user-1' },
      allowedProviders: ['openai'],
      allowedTools: ['get_pods'],
      allowedToolRefs: [{ serverId: 'server-1', toolName: 'get_pods' }]
    });
    const runTokenHeaders = {
      Authorization: `Bearer ${runToken}`,
      'content-type': 'application/json'
    };
    const toolCallBody = JSON.stringify({
      name: 'get_pods',
      toolAlias: 'get_pods',
      serverId: 'server-1',
      arguments: {}
    });

    await withTestServer(async (baseUrl) => {
      const publicResponse = await fetch(`${baseUrl}/api/v1/internal/mcp/tools/call`, {
        method: 'POST',
        headers: runTokenHeaders,
        body: toolCallBody
      });
      assert.equal(publicResponse.status, 404);

      const orchTokenResponse = await fetch(`${baseUrl}/internal/v1/mcp/tools/call`, {
        method: 'POST',
        headers: orchHeaders,
        body: toolCallBody
      });
      assert.equal(orchTokenResponse.status, 401);

      const internalResponse = await fetch(`${baseUrl}/internal/v1/mcp/tools/call`, {
        method: 'POST',
        headers: runTokenHeaders,
        body: toolCallBody
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
      principal: { type: 'user', id: 'user-1' },
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

  it('mounts platform-native tool callbacks only on the service-authenticated internal route', async () => {
    let getRunCalled = false;
    repo.getRun = async () => {
      getRunCalled = true;
      return null;
    };
    const headers = {
      Authorization: `Bearer ${config.ORCH_SERVICE_TOKEN}`,
      'content-type': 'application/json'
    };
    const body = JSON.stringify({ toolCallId: 'call-1', arguments: {} });

    await withTestServer(async (baseUrl) => {
      const publicResponse = await fetch(
        `${baseUrl}/api/v1/runs/run-1/native-tools/reports.pdf.generate/call`,
        { method: 'POST', headers, body }
      );
      assert.equal(publicResponse.status, 404);
      assert.equal(getRunCalled, false);

      const internalResponse = await fetch(
        `${baseUrl}/internal/v1/runs/run-1/native-tools/reports.pdf.generate/call`,
        { method: 'POST', headers, body }
      );
      assert.equal(internalResponse.status, 404);
      assert.equal(getRunCalled, true);
    });
  });

  it('does not mount the unreleased target-chat response export route', async () => {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/runs/run-1/report-artifacts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 404);
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
