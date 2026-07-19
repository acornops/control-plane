import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  getExactMcpReadinessReport,
  getTargetMcpConnectionReadinessErrors,
  getWorkflowCapabilityReadinessErrors,
  publicMcpReadinessError
} from '../../src/services/workflow-readiness.js';

afterEach(() => mock.restoreAll());

describe('target MCP personal connection readiness', () => {
  it('does not require unrelated personal installations when no exact tools are requested', async () => {
    let requestCount = 0;
    mock.method(globalThis, 'fetch', async () => {
      requestCount += 1;
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const errors = await getTargetMcpConnectionReadinessErrors(
      'workspace-1',
      'user-1',
      []
    );

    assert.deepEqual(errors, []);
    assert.equal(requestCount, 0);
  });

  for (const scenario of [
    {
      gatewayCode: 'MCP_PERSONAL_CONNECTION_MISSING',
      publicCode: 'MCP_PERSONAL_CONNECTION_REQUIRED',
      action: 'connect_mcp_server'
    },
    {
      gatewayCode: 'MCP_PERSONAL_CONNECTION_ERROR',
      publicCode: 'MCP_PERSONAL_CONNECTION_REQUIRED',
      action: 'verify_mcp_server'
    },
    {
      gatewayCode: 'MCP_PERSONAL_TOOL_UNAVAILABLE',
      publicCode: 'MCP_PERSONAL_CONNECTION_REQUIRED',
      action: 'verify_mcp_server'
    },
    {
      gatewayCode: 'MCP_PAT_USER_PRINCIPAL_REQUIRED',
      publicCode: 'MCP_PAT_USER_PRINCIPAL_REQUIRED'
    },
    {
      gatewayCode: 'MCP_INSTALLATION_UNAVAILABLE',
      publicCode: 'MCP_INSTALLATION_UNAVAILABLE'
    },
    {
      gatewayCode: 'MCP_REMOTE_DISABLED',
      publicCode: 'MCP_REMOTE_DISABLED'
    }
  ] as const) {
    it(`preserves bounded ${scenario.gatewayCode} details for public run conflicts`, async () => {
      mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        ready: false,
        failures: [{
          server_id: 'server-1',
          tool_name: 'records.list',
          code: scenario.gatewayCode,
          credential: 'must-not-leak',
          headers: { Authorization: 'Bearer must-not-leak' },
          server_url: 'https://mcp.example.test/private',
          user_id: 'user-secret',
          connection: { status: 'error', credential: 'must-not-leak' }
        }]
      }), { status: 200 }));

      const report = await getExactMcpReadinessReport(
        'workspace-1',
        { type: 'user', id: 'user-1' },
        [{ serverId: 'server-1', toolName: 'records.list' }]
      );
      const error = publicMcpReadinessError(report);

      assert.equal(error.code, scenario.publicCode);
      assert.deepEqual(error.details.readinessFailures, [{
        serverId: 'server-1',
        toolName: 'records.list',
        code: scenario.gatewayCode,
        ...('action' in scenario ? { action: scenario.action } : {})
      }]);
      assert.equal(JSON.stringify(error).includes('must-not-leak'), false);
      assert.equal(JSON.stringify(error).includes('mcp.example.test'), false);
      assert.equal(JSON.stringify(error).includes('user-secret'), false);
    });
  }

  it('rejects service principals before looking up a personal PAT connection', async () => {
    let readinessLookup = false;
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/connections/readiness')) readinessLookup = true;
      return new Response(JSON.stringify({ ready: false, failures: [{
        server_id: 'server-1', tool_name: 'records.list',
        code: 'MCP_PAT_USER_PRINCIPAL_REQUIRED'
      }] }), { status: 200 });
    });

    const errors = await getWorkflowCapabilityReadinessErrors(
      'workspace-1',
      { exactTargets: [], mcpTools: [{ serverId: 'server-1', toolName: 'records.list' }], mcpServers: ['server-1'] } as never,
      { id: 'target-1', targetType: 'kubernetes' } as never,
      { principal: { type: 'service_identity', id: 'service-1' } }
    );

    assert.deepEqual(errors, [
      'MCP_PAT_USER_PRINCIPAL_REQUIRED: personal MCP tool server-1/records.list requires a user principal.'
    ]);
    assert.equal(readinessLookup, true);
  });

  it('bounds failure counts and identifiers and normalizes unexpected gateway codes', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      ready: false,
      failures: Array.from({ length: 25 }, (_, index) => ({
        server_id: `server-${index}-${'s'.repeat(300)}`,
        tool_name: `tool-${index}-${'t'.repeat(300)}`,
        code: index === 0 ? 'MCP_GATEWAY_INTERNAL_DETAIL' : 'MCP_REMOTE_DISABLED',
        action: 'unexpected_action'
      }))
    }), { status: 200 }));

    const report = await getExactMcpReadinessReport(
      'workspace-1',
      { type: 'user', id: 'user-1' },
      [{ serverId: 'server-1', toolName: 'records.list' }]
    );

    assert.equal(report.failures.length, 20);
    assert.equal(report.errors.length, 20);
    assert.equal(report.failures[0]?.serverId.length, 256);
    assert.equal(report.failures[0]?.toolName.length, 256);
    assert.equal(report.failures[0]?.code, 'MCP_INSTALLATION_UNAVAILABLE');
    assert.equal(report.failures[0]?.action, undefined);
  });
});
