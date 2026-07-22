import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createAgent, runAgent } from '../src/controllers/agents-controller.js';
import { postMessage } from '../src/controllers/sessions-controller.js';
import { refreshAgentReadiness } from '../src/services/automation-readiness.js';
import { updateAgentMcpCapabilitySnapshot } from '../src/store/repository-agents.js';
import { createCapabilityRoutingMapping } from '../src/store/repository-capability-routing.js';
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

  it('returns bounded structured MCP readiness failures for direct Agent runs', async () => {
    installWorkspace('admin');
    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'MCP helper', instructions: 'Use the reviewed MCP tool.', status: 'active', reviewState: 'reviewed',
        semanticCapabilityIds: ['incident.report.generate']
      }
    ));
    assert.equal(created.statusCode, 201);
    const agentId = (created.body as { agent: { id: string } }).agent.id;
    const updated = await updateAgentMcpCapabilitySnapshot('workspace-1', agentId, {
      mcpServers: ['server-1'],
      mcpTools: [{ serverId: 'server-1', toolName: 'records.list' }],
      mcpInstallations: [{
        id: 'server-1', name: 'Records', url: 'https://mcp.example.test', enabled: true,
        credentialMode: 'individual', revision: 1, targetConstraints: { targetTypes: [], targetIds: [] },
        tools: [{
          serverId: 'server-1', toolName: 'records.list', alias: 'records_list',
          capability: 'read', enabled: true, reviewState: 'approved',
          riskLevel: 'read_only', autoAllowed: false
        }]
      }]
    }, 'user-1');
    assert.ok(updated);
    await createCapabilityRoutingMapping({
      workspaceId: 'workspace-1', capabilityId: 'incident.report.generate',
      agentId, agentVersion: updated.version, status: 'active', reviewState: 'reviewed', priority: 100,
      targetTypes: [], targetIds: [],
      mcpTools: [{
        serverId: 'server-1', toolName: 'records.list', alias: 'records_list', operation: 'read'
      }],
      nativeToolIds: [], skillIds: [], contextGrants: [], createdBy: 'user-1', reviewedBy: 'user-1'
    });
    await refreshAgentReadiness('workspace-1', agentId);
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/connections/readiness' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ready: false, failures: [{
          server_id: 'server-1', tool_name: 'records.list',
          code: 'MCP_CREDENTIAL_TOOL_UNAVAILABLE', action: 'verify_mcp_server',
          user_id: 'must-not-leak', connection: { credential: 'must-not-leak' }
        }] }), { status: 200 });
      }
      return new Response(`unexpected request: ${url.pathname}`, { status: 500 });
    });

    const response = await callController(runAgent, createRequest(
      { workspaceId: 'workspace-1', agentId },
      { prompt: 'List the records.' }
    ));

    assert.equal(response.statusCode, 409);
    const body = response.body as { error: { code: string; details: { readinessFailures: unknown[] } } };
    assert.equal(body.error.code, 'MCP_CONNECTION_REQUIRED');
    assert.deepEqual(body.error.details.readinessFailures, [{
      serverId: 'server-1', toolName: 'records.list',
      code: 'MCP_CREDENTIAL_TOOL_UNAVAILABLE', action: 'verify_mcp_server'
    }]);
    assert.equal(JSON.stringify(body).includes('must-not-leak'), false);
  });
});
