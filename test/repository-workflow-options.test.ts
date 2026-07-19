import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { getWorkflowOptionsCatalog } from '../src/store/repository-workflow-options.js';

afterEach(() => {
  mock.restoreAll();
});

function result<T>(rows: T[]) {
  return { rows, rowCount: rows.length };
}

describe('workflow option catalog repository', () => {
  it('loads tools, skills, and MCP servers from active Agent-owned capabilities', async () => {
    const observedWorkspaceIds: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      if (params?.length) observedWorkspaceIds.push(params[0]);
      if (sql.includes('FROM targets') && !sql.includes("target_type = 'kubernetes'")) {
        return result([{
          id: 'cluster-1', workspace_id: 'workspace-1', target_type: 'kubernetes', name: 'Production',
          status: 'online', metadata: {}, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
        }]);
      }
      if (sql.includes('FROM targets') && sql.includes("target_type = 'kubernetes'")) {
        return result([{
          id: 'cluster-1', workspace_id: 'workspace-1', target_type: 'kubernetes', name: 'Production',
          status: 'online', metadata: {}, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
        }]);
      }
      if (sql.includes('FROM agent_definitions') && sql.includes('mcp_installations')) {
        return result([{
          id: 'agent-1', name: 'Agent one', description: 'Durable agent', status: 'active',
          tools: ['list_resources'], skills: ['acornops-observability'], mcp_servers: ['generic-mcp'],
          mcp_installations: [{
            id: 'generic-mcp', name: 'Generic MCP', enabled: true,
            tools: [{
              serverId: 'generic-mcp', toolName: 'records.list', alias: 'generic-mcp.records.list',
              capability: 'read', enabled: true, reviewState: 'approved'
            }]
          }],
          skill_installations: [{ id: 'shared-skill', name: 'Shared skill', description: 'Agent skill', enabled: true }]
        }]);
      }
      if (sql.includes('FROM agent_definitions') && sql.includes("kind = 'specialist'")) {
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
      source: 'target', targetId: 'cluster-1', targetName: 'Production', targetType: 'kubernetes'
    });
    assert.equal(catalog.targets[0].provenance?.targetType, 'kubernetes');
    assert.equal(catalog.mcpServers[0].value, 'generic-mcp');
    assert.equal(catalog.mcpServers[0].disabled, false);
    assert.equal(catalog.mcpServers[0].provenance?.source, 'agent');
    assert.deepEqual(catalog.mcpServers.map((server) => server.value), ['generic-mcp']);
    assert.deepEqual(catalog.mcpTools.map((tool) => tool.value), [
      'list_resources', 'generic-mcp.records.list'
    ]);
    assert.equal(catalog.agents[0].disabled, true);
    assert.deepEqual(catalog.skills.map((skill) => skill.value), ['shared-skill', 'acornops-observability']);
    assert.equal(catalog.chatSessions[0].value, 'session-1');
    assert(Object.values(catalog.sourceAvailability).every((source) => source.status === 'available'));
  });

  it('isolates source query failures and distinguishes empty from unavailable', async () => {
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
    assert.equal(catalog.sourceAvailability.mcpServers.status, 'empty');
    assert.deepEqual(catalog.clusters, []);
  });

  it('keeps catalog reads free of lazy template or skill seeding', async () => {
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
