import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { requireTargetMcpConnectionsReady } from '../src/controllers/session-mcp-readiness.js';
import { repo } from '../src/store/repository.js';
import {
  createResponse,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const SERVER_ID = '00000000-0000-4000-8000-000000000002';
const TOOL_NAME = 'repository_status';
const TOOL_ALIAS = 'mcp__00000000000040008000000000000002__repository_status';

function installRemoteToolResolution(
  readinessCode: 'MCP_CONNECTION_MISSING' | 'MCP_INSTALLATION_UNAVAILABLE' = 'MCP_CONNECTION_MISSING'
): void {
  repo.getTargetAgentRegistration = async () => ({
    workspaceId: 'workspace-1',
    targetId: 'target-1',
    targetType: 'virtual_machine',
    agentKeyHash: 'hash',
    keyVersion: 1,
    capabilities: ['read']
  });
  repo.listTargetToolOverrides = async () => ({});
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/mcp/tools?')) {
      return new Response(JSON.stringify([{
        name: TOOL_NAME,
        server_id: SERVER_ID,
        model_alias: TOOL_ALIAS,
        mcp_server_url: 'https://mock.example.test/mcp',
        timeout_ms: 10000,
        description: 'Read repository status',
        capability: 'read',
        version: 'v1',
        source: 'mcp',
        input_schema: { type: 'object' },
        enabled: true
      }]), { status: 200 });
    }
    if (url.endsWith('/api/v1/internal/mcp/connections/readiness') && init?.method === 'POST') {
      return new Response(JSON.stringify({
        ready: false,
        failures: [{
          server_id: SERVER_ID,
          tool_name: TOOL_NAME,
          code: readinessCode,
          ...(readinessCode === 'MCP_CONNECTION_MISSING'
            ? { action: 'connect_mcp_server' }
            : {})
        }]
      }), { status: 200 });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  });
}

afterEach(restoreControllerRegressionState);

describe('interactive target MCP readiness', () => {
  it('allows chat to continue when an unreferenced MCP credential is unavailable', async () => {
    installRemoteToolResolution();
    const response = createResponse();

    const ready = await requireTargetMcpConnectionsReady(
      response as never,
      'workspace-1',
      { targetId: 'target-1', targetType: 'virtual_machine' },
      'user-2',
      'read_only',
      []
    );

    assert.equal(ready, true);
    assert.equal(response.statusCode, 200);
  });

  it('keeps an explicitly referenced unavailable MCP tool fail-closed', async () => {
    installRemoteToolResolution();
    const response = createResponse();

    const ready = await requireTargetMcpConnectionsReady(
      response as never,
      'workspace-1',
      { targetId: 'target-1', targetType: 'virtual_machine' },
      'user-2',
      'read_only',
      [{
        kind: 'tool',
        id: TOOL_ALIAS,
        label: 'Repository status',
        description: 'Read repository status',
        capability: 'read',
        source: 'mcp',
        serverId: SERVER_ID,
        toolName: TOOL_NAME
      }]
    );

    assert.equal(ready, false);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MCP_CONNECTION_REQUIRED');
  });

  it('keeps installation-level MCP failures fail-closed without an explicit reference', async () => {
    installRemoteToolResolution('MCP_INSTALLATION_UNAVAILABLE');
    const response = createResponse();

    const ready = await requireTargetMcpConnectionsReady(
      response as never,
      'workspace-1',
      { targetId: 'target-1', targetType: 'virtual_machine' },
      'user-2',
      'read_only',
      []
    );

    assert.equal(ready, false);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MCP_INSTALLATION_UNAVAILABLE');
  });
});
