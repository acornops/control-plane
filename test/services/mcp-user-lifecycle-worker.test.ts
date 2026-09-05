import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { config } from '../../src/config.js';
import { db } from '../../src/infra/db.js';
import {
  reconcileWorkspaceMemberMcpLifecycle,
  runMcpUserLifecycleReconciliationTick
} from '../../src/services/mcp-user-lifecycle-worker.js';

afterEach(() => mock.restoreAll());

function result(rows: unknown[] = []) {
  return { rows, rowCount: rows.length };
}

describe('MCP user lifecycle reconciliation worker', () => {
  it('claims only the immediate bounded batch and sends bigint generations as safe JSON integers', async () => {
    let claimSql = '';
    let claimParams: unknown[] = [];
    const completionUpdates: Array<{ sql: string; params: unknown[] }> = [];
    const gatewayBodies: Array<Record<string, unknown>> = [];
    const client = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('WITH candidates AS')) {
          claimSql = sql;
          claimParams = params;
          return result([
            {
              workspace_id: 'workspace-a', user_id: 'user-a', membership_generation: '10',
              status: 'removed', reconciliation_status: 'processing', attempt_count: 1,
              lease_owner: 'worker:claim-a'
            },
            {
              workspace_id: 'workspace-b', user_id: 'user-b', membership_generation: '2',
              status: 'active', reconciliation_status: 'processing', attempt_count: 0,
              lease_owner: 'worker:claim-a'
            }
          ]);
        }
        return result();
      },
      release() {}
    };
    mock.method(db, 'connect', async () => client as never);
    mock.method(db, 'query', async (sql: string, params: unknown[] = []) => {
      completionUpdates.push({ sql, params });
      return result();
    });
    mock.method(globalThis, 'fetch', async (_url, init) => {
      gatewayBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    });

    assert.equal(await runMcpUserLifecycleReconciliationTick(25), 2);
    assert.equal(claimParams[0], 2);
    assert.equal(claimParams[2], Math.ceil(config.LLM_GATEWAY_TIMEOUT_MS / 1000) + 30);
    assert.match(claimSql, /DISTINCT ON \(lifecycle\.workspace_id\)/);
    assert.match(claimSql, /in_flight\.reconciliation_status='processing'/);
    assert.match(claimSql, /CASE WHEN lifecycle\.status='removed' THEN 0 ELSE 1 END/);
    assert.match(claimSql, /reconciliation_status='processing' AND lifecycle\.lease_expires_at<NOW\(\)/);
    assert.deepEqual(
      gatewayBodies.map((body) => body.membership_generation as number).sort((a, b) => a - b),
      [2, 10]
    );
    assert.ok(completionUpdates.every(({ sql }) => (
      sql.includes("reconciliation_status='processing' AND lease_owner=$5")
      && sql.includes('blocks_readiness=false')
    )));
  });

  it('rejects an unsafe bigint claim before making an upstream request', async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes('WITH candidates AS')) {
          return result([{
            workspace_id: 'workspace-a', user_id: 'user-a',
            membership_generation: '9007199254740992', status: 'active',
            reconciliation_status: 'processing', attempt_count: 0, lease_owner: 'claim'
          }]);
        }
        return result();
      },
      release() {}
    };
    mock.method(db, 'connect', async () => client as never);
    const upstream = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));

    await assert.rejects(
      () => runMcpUserLifecycleReconciliationTick(),
      /outside the safe integer range/
    );
    assert.equal(upstream.mock.callCount(), 0);
  });

  it('marks a foreground failure durably and rethrows so committed membership mutations return an error', async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    mock.method(db, 'query', async (sql: string, params: unknown[] = []) => {
      updates.push({ sql, params });
      return result();
    });
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      detail: {
        code: 'MCP_USER_LIFECYCLE_TEARDOWN_FAILED',
        message: 'MCP user lifecycle teardown did not complete.',
        retryable: true
      }
    }), { status: 503, headers: { 'content-type': 'application/json' } }));

    await assert.rejects(
      () => reconcileWorkspaceMemberMcpLifecycle({
        workspaceId: 'workspace-a',
        userId: 'user-a',
        membershipGeneration: 4,
        status: 'removed'
      }),
      (error: unknown) => Boolean(
        error && typeof error === 'object'
        && 'gatewayCode' in error
        && error.gatewayCode === 'MCP_USER_LIFECYCLE_TEARDOWN_FAILED'
      )
    );
    assert.equal(updates.length, 1);
    assert.match(updates[0].sql, /reconciliation_status<>'synced'/);
    assert.equal(updates[0].params[2], 4);
  });

  it('treats a lower delayed removal as complete only when the local durable generation is newer', async () => {
    const updates: string[] = [];
    const client = {
      async query(sql: string) {
        if (sql.includes('WITH candidates AS')) {
          return result([{
            workspace_id: 'workspace-a', user_id: 'user-a', membership_generation: '10',
            status: 'removed', reconciliation_status: 'processing', attempt_count: 1,
            lease_owner: 'worker:claim-stale'
          }]);
        }
        return result();
      },
      release() {}
    };
    mock.method(db, 'connect', async () => client as never);
    mock.method(db, 'query', async (sql: string) => {
      updates.push(sql);
      if (sql.includes('SELECT membership_generation')) {
        return result([{ membership_generation: '11' }]);
      }
      return result();
    });
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      detail: {
        code: 'MCP_USER_LIFECYCLE_STALE',
        message: 'The workspace membership generation is older than the gateway lifecycle state.',
        retryable: false
      }
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    assert.equal(await runMcpUserLifecycleReconciliationTick(), 1);
    assert.equal(updates.filter((sql) => sql.startsWith('UPDATE')).length, 0);
  });
});
