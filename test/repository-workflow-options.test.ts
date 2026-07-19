import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { configureWorkflowBuiltInMcpCatalogForTests } from '../src/services/workflow-built-in-mcp-catalog.js';
import { getWorkflowOptionsCatalog } from '../src/store/repository-workflow-options.js';
import { configureWorkflowMcpRepositoryForTests } from '../src/store/repository-workflow-mcp.js';

afterEach(() => {
  mock.restoreAll();
  configureWorkflowBuiltInMcpCatalogForTests();
  configureWorkflowMcpRepositoryForTests();
});

function result<T>(rows: T[]) {
  return { rows, rowCount: rows.length };
}

describe('workflow option catalog repository', () => {
  it('loads built-in tools plus explicitly user-configured workspace MCP tools', async () => {
    configureWorkflowBuiltInMcpCatalogForTests(async () => ({
      server: { id: 'acornops-target-agent', name: 'AcornOps Target Tools', enabled: true, targetIds: ['cluster-1'] },
      tools: [{
        name: 'list_resources', description: 'List Kubernetes resources', capability: 'read',
        inputSchema: { type: 'object' }, enabled: true, targetIds: ['cluster-1']
      }]
    }));
    configureWorkflowMcpRepositoryForTests({
      list: async () => [{
        id: 'generic-mcp', workspaceId: 'workspace-1', scope: 'workspace', name: 'Generic MCP',
        url: 'https://mcp.example.test', enabled: false, authType: 'none', credentialConfigured: false,
        publicHeaders: {}, status: 'disabled', tools: [{ name: 'records.list', title: 'List records', capability: 'read', enabled: true }],
        createdBy: 'test', createdAt: '2026-01-01T00:00:00.000Z'
      }],
      create: async () => { throw new Error('unused'); }, update: async () => null,
      delete: async () => false, test: async () => null, tools: async () => []
    });
    const observedWorkspaceIds: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      if (params?.length) observedWorkspaceIds.push(params[0]);
      if (sql.includes('FROM targets') && sql.includes("target_type = 'kubernetes'")) {
        return result([{
          id: 'cluster-1', workspace_id: 'workspace-1', target_type: 'kubernetes', name: 'Production',
          status: 'online', metadata: {}, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
        }]);
      }
      if (sql.includes("'workspace'::text AS source_kind")) {
        return result([
          { id: 'shared-skill', name: 'Shared skill', description: 'Workspace skill', source_kind: 'workspace', target_id: null, target_name: null, source_provider: null },
          { id: 'target-skill', name: 'Target skill', description: 'Target skill', source_kind: 'target', target_id: 'cluster-1', target_name: 'Production', source_provider: 'github' }
        ]);
      }
      if (sql.includes('FROM agent_definitions') && sql.includes("kind = 'specialist_agent'")) {
        return result([{ id: 'agent-1', name: 'Agent one', description: 'Durable agent', status: 'disabled' }]);
      }
      if (sql.includes('FROM sessions session')) {
        return result([{ id: 'session-1', title: 'Incident', target_id: 'cluster-1', target_name: 'Production' }]);
      }
      return result([]);
    });

    const catalog = await getWorkflowOptionsCatalog('workspace-1');

    assert(observedWorkspaceIds.every((workspaceId) => workspaceId === 'workspace-1'));
    assert.deepEqual(catalog.clusters[0].provenance, {
      source: 'target', targetId: 'cluster-1', targetName: 'Production'
    });
    assert.equal(catalog.mcpServers[0].value, 'acornops-target-agent');
    assert.equal(catalog.mcpServers[0].disabled, false);
    assert.equal(catalog.mcpServers[0].provenance?.source, 'target');
    assert.deepEqual(catalog.mcpServers.map((server) => server.value), ['acornops-target-agent', 'generic-mcp']);
    assert.deepEqual(catalog.mcpTools.map((tool) => tool.value), [
      'list_resources', 'chat.sessions.read_selected', 'reports.pdf.generate', 'records.list'
    ]);
    assert.equal(catalog.mcpTools.find((tool) => tool.value === 'records.list')?.disabled, true);
    assert.equal(catalog.agents[0].disabled, true);
    assert.equal(catalog.skills[1].value, 'target:cluster-1:target-skill');
    assert.equal(catalog.chatSessions[0].value, 'session-1');
    assert(Object.values(catalog.sourceAvailability).every((source) => source.status === 'available'));
  });

  it('isolates source query failures and distinguishes empty from unavailable', async () => {
    configureWorkflowMcpRepositoryForTests({
      list: async () => [], create: async () => { throw new Error('unused'); }, update: async () => null,
      delete: async () => false, test: async () => null, tools: async () => []
    });
    mock.method(db, 'query', async (sql: string) => {
      if (sql.includes('FROM targets') && sql.includes("target_type = 'kubernetes'")) {
        const error = new Error('database unavailable') as Error & { code: string };
        error.code = '57P01';
        throw error;
      }
      return result([]);
    });

    const catalog = await getWorkflowOptionsCatalog('workspace-empty');

    assert.equal(catalog.sourceAvailability.clusters.status, 'error');
    assert.equal(catalog.sourceAvailability.clusters.errorCode, 'DATABASE_57P01');
    assert.equal(catalog.sourceAvailability.clusters.retryable, true);
    assert.equal(catalog.sourceAvailability.chatSessions.status, 'empty');
    assert.equal(catalog.sourceAvailability.mcpServers.status, 'error');
    assert.deepEqual(catalog.clusters, []);
  });

  it('keeps catalog reads free of lazy template or skill seeding', async () => {
    configureWorkflowMcpRepositoryForTests({
      list: async () => [], create: async () => { throw new Error('unused'); }, update: async () => null,
      delete: async () => false, test: async () => null, tools: async () => []
    });
    const statements: string[] = [];
    mock.method(db, 'query', async (sql: string) => {
      statements.push(sql);
      return result([]);
    });

    await getWorkflowOptionsCatalog('workspace-seed');

    for (const table of ['agent_definitions', 'workflow_definitions', 'workspace_skills']) {
      assert.equal(
        statements.some((sql) => sql.includes(`INSERT INTO ${table}`)),
        false,
        `catalog reads must not lazily seed ${table}`
      );
    }
  });
});
