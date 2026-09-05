import { mock } from 'node:test';
import { config } from '../../src/config.js';
import {
  createReadyMcpReadinessResponse,
  isMcpReadinessRequest
} from './controller-regression-fixtures.js';

/** Install the smallest stateful gateway needed to register Agent Targets tools. */
export function installAgentTargetsGatewayFixture(): void {
  let builtInServer: Record<string, unknown> | undefined;
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/mcp/servers?') && init?.method === 'GET') {
      return Response.json(builtInServer ? [builtInServer] : []);
    }
    if (url.endsWith('/api/v1/internal/mcp/servers/builtin') && init?.method === 'PUT') {
      const request = JSON.parse(String(init.body)) as {
        agent_id: string;
        server_name: string;
        enabled: boolean;
        tools: Array<Record<string, unknown> & { name: string }>;
      };
      const serverId = '11111111-1111-4111-8111-111111111111';
      builtInServer = {
        id: serverId,
        workspace_id: 'workspace-1',
        scope_type: 'agent',
        agent_id: request.agent_id,
        server_name: request.server_name,
        server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
        enabled: request.enabled,
        auth_type: 'none',
        credential_mode: 'none',
        public_headers: {},
        provenance_type: 'builtin',
        revision: 1,
        tools: request.tools.map((tool) => ({
          ...tool,
          server_id: serverId,
          model_alias: `m_targets_${tool.name}_1`,
          mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL
        }))
      };
      return Response.json(builtInServer);
    }
    if (isMcpReadinessRequest(input, init)) return createReadyMcpReadinessResponse();
    return new Response(`unexpected request: ${url}`, { status: 500 });
  });
}
