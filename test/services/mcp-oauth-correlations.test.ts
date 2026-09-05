import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { db } from '../../src/infra/db.js';
import {
  deleteExpiredMcpOAuthCorrelations,
  getMcpOAuthStateCorrelation,
  recordMcpOAuthStateCorrelation
} from '../../src/store/repository-mcp-oauth-correlations.js';

afterEach(() => mock.restoreAll());

describe('MCP OAuth state correlations', () => {
  it('binds callback lookup to the exact initiating user and captured generation', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [{
        workspace_id: 'workspace-1',
        user_id: 'user-1',
        server_id: 'server-1',
        return_path: '/workspaces/workspace-1/mcp',
        membership_generation: '7'
      }] } as never;
    });

    const correlation = await getMcpOAuthStateCorrelation('s'.repeat(43), 'user-1');

    assert.equal(correlation?.membershipGeneration, 7);
    assert.match(queries[0].sql, /state_hash=\$1 AND user_id=\$2 AND expires_at>NOW\(\)/);
    assert.equal(queries[0].params[1], 'user-1');
  });

  it('rejects a duplicate opaque state instead of accepting another correlation', async () => {
    mock.method(db, 'query', async () => ({ rowCount: 0, rows: [] }) as never);

    await assert.rejects(recordMcpOAuthStateCorrelation({
      state: 's'.repeat(43),
      workspaceId: 'workspace-1',
      userId: 'user-1',
      serverId: 'server-1',
      returnPath: '/workspaces/workspace-1/mcp',
      membershipGeneration: 7
    }), /already exists/);
  });

  it('purges state and preparation correlations in bounded batches', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] } as never;
    });

    await deleteExpiredMcpOAuthCorrelations(25);

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.params[0] === 25));
    assert.match(calls[0].sql, /mcp_oauth_state_correlations/);
    assert.match(calls[1].sql, /mcp_oauth_preparation_correlations/);
  });
});
