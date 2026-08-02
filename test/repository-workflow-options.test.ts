import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { getCapabilityOptionsCatalog } from '../src/store/repository-capability-options.js';

afterEach(() => {
  mock.restoreAll();
});

function result<T>(rows: T[]) {
  return { rows, rowCount: rows.length };
}

describe('workflow option catalog repository', () => {
  it('loads only assignable Agents for Workflow authoring', async () => {
    const observedWorkspaceIds: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      if (params?.length) observedWorkspaceIds.push(params[0]);
      if (sql.includes('FROM agent_definitions')) {
        return result([{ id: 'agent-1', name: 'Agent one', description: 'Durable agent', status: 'disabled' }]);
      }
      return result([]);
    });

    const catalog = await getCapabilityOptionsCatalog('workspace-1');

    assert(observedWorkspaceIds.every((workspaceId) => workspaceId === 'workspace-1'));
    assert.equal(catalog.agents[0].disabled, true);
    assert.deepEqual(Object.keys(catalog.sourceAvailability), ['agents']);
    assert.equal(catalog.sourceAvailability.agents.status, 'available');
    assert.deepEqual(Object.keys(catalog).sort(), ['agents', 'sourceAvailability']);
  });

  it('isolates source query failures and distinguishes empty from unavailable', async () => {
    mock.method(db, 'query', async (sql: string) => {
      if (sql.includes('FROM agent_definitions')) {
        const error = new Error('database unavailable') as Error & { code: string };
        error.code = '57P01';
        throw error;
      }
      return result([]);
    });

    const catalog = await getCapabilityOptionsCatalog('workspace-empty');

    assert.equal(catalog.sourceAvailability.agents.status, 'error');
    assert.equal(catalog.sourceAvailability.agents.errorCode, 'DATABASE_57P01');
    assert.equal(catalog.sourceAvailability.agents.retryable, true);
    assert.deepEqual(catalog.agents, []);
  });

  it('keeps catalog reads free of lazy template or skill seeding', async () => {
    const statements: string[] = [];
    mock.method(db, 'query', async (sql: string) => {
      statements.push(sql);
      return result([]);
    });

    await getCapabilityOptionsCatalog('workspace-seed');

    for (const table of ['agent_definitions', 'workflow_definitions', 'workspace_skills']) {
      assert.equal(
        statements.some((sql) => sql.includes(`INSERT INTO ${table}`)),
        false,
        `catalog reads must not lazily seed ${table}`
      );
    }
  });
});
