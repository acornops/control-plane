import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';

import { db } from '../../src/infra/db.js';
import { signRunScopeTokenForCurrentPrincipal } from '../../src/services/current-principal-token.js';
import type { RunScopeClaims } from '../../src/services/run-scope-claims.js';
import { gatewayTokenService } from '../../src/services/token-service.js';

afterEach(() => mock.restoreAll());

function claims(membershipGeneration = 7): RunScopeClaims {
  return {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    targetId: 'target-1',
    targetType: 'virtual_machine',
    sessionId: 'session-1',
    userId: 'user-1',
    principal: { type: 'user', id: 'user-1', membershipGeneration },
    allowedProviders: ['openai'],
    allowedTools: []
  };
}

function installLifecycleTransaction(input: {
  membershipPresent?: boolean;
  generation?: number | string;
  status?: 'active' | 'removed';
  reconciliationStatus?: 'pending' | 'processing' | 'failed' | 'synced';
} = {}): string[] {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM workspace_memberships membership')) {
        return input.membershipPresent === false
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ workspace_id: 'workspace-1' }] };
      }
      if (sql.includes('FROM workspace_member_mcp_lifecycle lifecycle')) {
        return { rowCount: 1, rows: [{
          workspace_id: 'workspace-1',
          user_id: 'user-1',
          membership_generation: input.generation ?? '7',
          status: input.status ?? 'active',
          reconciliation_status: input.reconciliationStatus ?? 'synced'
        }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {
      statements.push('RELEASE');
    }
  };
  mock.method(db, 'connect', async () => client as never);
  return statements;
}

describe('current MCP principal token issuance', () => {
  it('is the only user-token issuance boundary for target, Agent, and Workflow bootstraps', () => {
    for (const relativePath of [
      '../../src/controllers/internal-target-run-bootstrap.ts',
      '../../src/controllers/internal-agent-chat-bootstrap.ts',
      '../../src/controllers/internal-execution-bootstrap.ts'
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      assert.match(source, /signRunScopeTokenForCurrentPrincipal\(/, relativePath);
      assert.doesNotMatch(source, /gatewayTokenService\.signRunScopeToken\(/, relativePath);
      assert.match(source, /MCP_USER_LIFECYCLE_STALE/, relativePath);
    }
  });

  it('signs the exact active generation while membership and lifecycle share locks are held', async () => {
    const statements = installLifecycleTransaction();
    const sign = mock.method(gatewayTokenService, 'signRunScopeToken', async () => {
      assert.equal(statements.includes('COMMIT'), false);
      statements.push('SIGN');
      return 'signed-token';
    });

    assert.deepEqual(await signRunScopeTokenForCurrentPrincipal(claims()), {
      current: true,
      token: 'signed-token'
    });
    assert.equal(sign.mock.callCount(), 1);
    assert.deepEqual(statements.map((sql) => {
      if (sql.includes('FROM workspace_memberships membership')) return 'LOCK_MEMBERSHIP';
      if (sql.includes('FROM workspace_member_mcp_lifecycle lifecycle')) return 'LOCK_LIFECYCLE';
      return sql;
    }), ['BEGIN', 'LOCK_MEMBERSHIP', 'LOCK_LIFECYCLE', 'SIGN', 'COMMIT', 'RELEASE']);
    assert.match(statements[1], /FOR SHARE OF membership/);
    assert.match(statements[2], /FOR SHARE OF lifecycle/);
  });

  for (const [name, lifecycle] of Object.entries({
    'removed membership': { status: 'removed' as const },
    'pending reconciliation': { reconciliationStatus: 'pending' as const },
    're-added higher generation': { generation: '8' }
  })) {
    it(`rejects a pinned token for ${name} without signing`, async () => {
      installLifecycleTransaction(lifecycle);
      const sign = mock.method(gatewayTokenService, 'signRunScopeToken', async () => 'unexpected');

      assert.deepEqual(await signRunScopeTokenForCurrentPrincipal(claims(7)), { current: false });
      assert.equal(sign.mock.callCount(), 0);
    });
  }

  it('rejects when the workspace membership row has already been deleted', async () => {
    const statements = installLifecycleTransaction({ membershipPresent: false });
    const sign = mock.method(gatewayTokenService, 'signRunScopeToken', async () => 'unexpected');

    assert.deepEqual(await signRunScopeTokenForCurrentPrincipal(claims()), { current: false });
    assert.equal(sign.mock.callCount(), 0);
    assert.equal(statements.some((sql) => sql.includes('workspace_member_mcp_lifecycle')), false);
  });

  it('signs service identities without consulting workspace membership state', async () => {
    const connect = mock.method(db, 'connect', async () => {
      throw new Error('service identities must not use the membership ledger');
    });
    mock.method(gatewayTokenService, 'signRunScopeToken', async () => 'service-token');

    assert.deepEqual(await signRunScopeTokenForCurrentPrincipal({
      ...claims(),
      userId: undefined,
      principal: { type: 'service_identity', id: 'scheduler-1' }
    }), { current: true, token: 'service-token' });
    assert.equal(connect.mock.callCount(), 0);
  });
});
