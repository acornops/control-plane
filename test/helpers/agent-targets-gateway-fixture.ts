import { mock } from 'node:test';
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
    if (url.endsWith('/api/v1/internal/mcp/servers') && init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as {
        agent_id: string;
        server_name: string;
        server_url: string;
        tools: Array<Record<string, unknown> & { name: string }>;
      };
      const serverId = '11111111-1111-4111-8111-111111111111';
      builtInServer = {
        id: serverId,
        workspace_id: 'workspace-1',
        scope_type: 'agent',
        agent_id: request.agent_id,
        server_name: request.server_name,
        server_url: request.server_url,
        enabled: true,
        auth_type: 'none',
        credential_mode: 'none',
        public_headers: {},
        provenance_type: 'builtin',
        revision: 1,
        tools: request.tools.map((tool) => ({
          ...tool,
          server_id: serverId,
          model_alias: `m_targets_${tool.name}_1`,
          mcp_server_url: request.server_url
        }))
      };
      return Response.json(builtInServer, { status: 201 });
    }
    if (isMcpReadinessRequest(input, init)) return createReadyMcpReadinessResponse();
    return new Response(`unexpected request: ${url}`, { status: 500 });
  });
}
