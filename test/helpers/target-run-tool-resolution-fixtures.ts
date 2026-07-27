import { mock } from 'node:test';
import type { McpToolConfig } from '../../src/services/mcp-registry-client.js';
import { repo } from '../../src/store/repository.js';

export const BASE_TOOLS: McpToolConfig[] = [
  {
    name: 'restart_service',
    server_id: '00000000-0000-4000-8000-000000000001',
    model_alias: 'mcp__00000000000040008000000000000001__restart_service',
    mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
    timeout_ms: 10000,
    description: 'Restart a service',
    capability: 'write',
    version: 'v1',
    source: 'builtin',
    input_schema: { type: 'object', description: 'Restart input' },
    enabled: true
  },
  {
    name: 'query_logs',
    server_id: '00000000-0000-4000-8000-000000000001',
    model_alias: 'mcp__00000000000040008000000000000001__query_logs',
    mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
    timeout_ms: 10000,
    description: 'Read logs',
    capability: 'read',
    version: 'v1',
    source: 'builtin',
    input_schema: { type: 'object' },
    enabled: true
  }
];

export function mockToolList(tools: McpToolConfig[]): void {
  mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/mcp/tools?')) {
      return new Response(JSON.stringify(tools), { status: 200 });
    }
    return new Response('unexpected request', { status: 500 });
  });
}

export function installResolverRepoStubs(capabilities: string[] = ['read', 'write']): void {
  repo.getTargetAgentRegistration = async () => ({
    workspaceId: 'workspace-1',
    targetId: 'target-1',
    targetType: 'virtual_machine',
    agentKeyHash: 'hash',
    keyVersion: 1,
    capabilities
  });
  repo.listTargetToolOverrides = async () => ({});
  repo.getTargetToolSetting = async () => null;
  repo.listEnabledTargetToolSettings = async () => [];
  repo.listEnabledValidTargetSkills = async () => [];
  repo.listEnabledValidTargetSkillSummaries = async () => [];
  repo.listMatchingWebhookSubscriptions = async () => [];
}
