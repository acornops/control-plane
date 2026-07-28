import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { bootstrap } from '../src/controllers/internal-execution-controller.js';
import { gatewayTokenService } from '../src/services/token-service.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  createRun,
  createSessionRecord,
  createTarget,
  createWorkspaceAiCredentialStatusResponse,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  repo.getRunSkillCatalog = async () => [];
  repo.getTargetToolSetting = async () => null;
  repo.listEnabledTargetToolSettings = async () => [];
});
afterEach(restoreControllerRegressionState);
after(closeAutomationDatabaseFixtures);

describe('interactive MCP bootstrap filtering', () => {
  it('omits unavailable user-credential tools from every authority surface', async () => {
    const remoteServerId = '00000000-0000-4000-8000-000000000002';
    const remoteToolName = 'repository_status';
    const remoteAlias = 'mcp__00000000000040008000000000000002__repository_status';
    repo.getRun = async () => createRun({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      toolAccessMode: 'read_only',
      principal: { type: 'user', id: 'user-2' }
    });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => ({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      workspaceId: 'workspace-1',
      agentKeyHash: 'hash',
      keyVersion: 1,
      capabilities: ['read']
    });
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([
          {
            name: 'query_logs',
            server_id: '00000000-0000-4000-8000-000000000001',
            model_alias: 'query_logs',
            mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
            timeout_ms: 10000,
            description: 'Read VM logs',
            capability: 'read',
            version: 'v2',
            source: 'builtin',
            input_schema: { type: 'object' },
            enabled: true
          },
          {
            name: remoteToolName,
            server_id: remoteServerId,
            model_alias: remoteAlias,
            mcp_server_url: 'https://mock.example.test/mcp',
            timeout_ms: 10000,
            description: 'Read repository status',
            capability: 'read',
            version: 'v1',
            source: 'mcp',
            input_schema: { type: 'object' },
            enabled: true
          }
        ]), { status: 200 });
      }
      if (url.endsWith('/api/v1/internal/mcp/connections/readiness') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          ready: false,
          failures: [{
            server_id: remoteServerId,
            tool_name: remoteToolName,
            code: 'MCP_CONNECTION_MISSING',
            action: 'connect_mcp_server'
          }]
        }), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const tools = (response.body as {
      tools: {
        allowed_tools: string[];
        allowed_tool_refs: Array<{ server_id: string; tool_name: string }>;
        tool_specs: Array<{ name: string; tool_name?: string }>;
        gateway: { token: string };
      };
    }).tools;

    assert.equal(response.statusCode, 200);
    assert.equal(tools.allowed_tools.includes(remoteAlias), false);
    assert.equal(tools.allowed_tool_refs.some((ref) => ref.tool_name === remoteToolName), false);
    assert.equal(tools.tool_specs.some((spec) => spec.tool_name === remoteToolName), false);
    const claims = await gatewayTokenService.verifyRunScopeToken(tools.gateway.token);
    assert.equal(claims.allowedTools.includes(remoteAlias), false);
    assert.equal(claims.allowedToolRefs.some((ref) => ref.toolName === remoteToolName), false);
  });
});
