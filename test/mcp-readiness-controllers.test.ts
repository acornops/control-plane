import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { postMessage } from '../src/controllers/sessions-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  createSessionRecord,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
afterEach(restoreControllerRegressionState);
after(closeAutomationDatabaseFixtures);

describe('public MCP readiness controller responses', () => {
  it('returns bounded structured MCP readiness failures for target messages', async () => {
    installWorkspace('operator');
    repo.getSession = async () =>
      createSessionRecord({ targetId: 'target-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => ({ capabilities: ['read'] }) as never;
    repo.listTargetToolOverrides = async () => ({});
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/tools' && init?.method === 'GET') {
        return new Response(JSON.stringify([{
          name: 'records.list', server_id: 'server-1', model_alias: 'records_list',
          mcp_server_url: 'https://must-not-leak.example/mcp', timeout_ms: 10000,
          capability: 'read', source: 'mcp', enabled: true
        }]), { status: 200 });
      }
      if (url.pathname === '/api/v1/internal/mcp/connections/readiness' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ready: false, failures: [{
          server_id: 'server-1', tool_name: 'records.list',
          code: 'MCP_CONNECTION_MISSING', action: 'connect_mcp_server',
          credential: 'must-not-leak', headers: { Authorization: 'Bearer must-not-leak' }
        }] }), { status: 200 });
      }
      return new Response(`unexpected request: ${url.pathname}`, { status: 500 });
    });

    const response = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_only' })
    );

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { error: {
      code: 'MCP_CONNECTION_REQUIRED',
        message: 'Connect a credential for MCP tool server-1/records.list.',
      retryable: false,
      details: {
        readinessFailures: [{
          serverId: 'server-1', toolName: 'records.list',
          code: 'MCP_CONNECTION_MISSING', action: 'connect_mcp_server'
        }],
        action: 'connect_mcp_server'
      }
    } });
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);
  });
});
