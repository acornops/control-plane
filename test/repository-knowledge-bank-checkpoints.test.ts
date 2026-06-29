import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  claimDueKnowledgeBankCheckpointJobs,
  finishKnowledgeBankCheckpointJob,
  renewKnowledgeBankCheckpointJobLeaseIfCurrent,
  rescheduleKnowledgeBankCheckpointJob,
  upsertKnowledgeBankCheckpointJobForSessionActivity
} from '../src/store/repository-knowledge-bank-checkpoints.js';

afterEach(() => {
  mock.restoreAll();
});

describe('Knowledge Bank checkpoint job repository', () => {
  it('reclaims expired processing jobs when claiming due checkpoint work', async () => {
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      assert.match(sql, /job\.status IN \('queued', 'failed', 'processing'\)/);
      assert.match(sql, /job\.lease_expires_at IS NULL OR job\.lease_expires_at <= NOW\(\)/);
      assert.deepEqual(params, [50, 'worker-1', 300]);
      return {
        rowCount: 1,
        rows: [{
          workspace_id: 'workspace-1',
          target_id: 'target-1',
          target_type: 'kubernetes',
          session_id: 'session-1',
          last_activity_at: new Date('2026-06-29T01:00:00.000Z'),
          lease_owner: 'worker-1',
          config_json: null,
          tool_enabled: null,
          session_active: true,
          session_last_message_at: new Date('2026-06-29T01:00:00.000Z'),
          has_active_run: false,
          has_pending_approval: false
        }]
      };
    });

    const jobs = await claimDueKnowledgeBankCheckpointJobs(50, 'worker-1');

    assert.deepEqual(jobs, [{
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'kubernetes',
      sessionId: 'session-1',
      lastActivityAt: '2026-06-29T01:00:00.000Z',
      leaseOwner: 'worker-1',
      config: {},
      toolEnabled: true,
      sessionActive: true,
      sessionLastMessageAt: '2026-06-29T01:00:00.000Z',
      hasActiveRun: false,
      hasPendingApproval: false
    }]);
  });

  it('resets attempts when new session activity replaces older checkpoint work', async () => {
    const queries: string[] = [];
    mock.method(db, 'query', async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {
        return {
          rowCount: 1,
          rows: [{
            workspace_id: 'workspace-1',
            target_id: 'target-1',
            target_type: 'kubernetes',
            tool_enabled: true,
            config_json: null
          }]
        };
      }
      assert.match(sql, /attempts = CASE/);
      assert.match(sql, /last_activity_at < EXCLUDED\.last_activity_at THEN 0/);
      assert.match(sql, /WHERE target_knowledge_checkpoint_jobs\.last_activity_at < EXCLUDED\.last_activity_at/);
      return { rowCount: 1, rows: [] };
    });

    await upsertKnowledgeBankCheckpointJobForSessionActivity('session-1', '2026-06-29T01:00:00.000Z');

    assert.equal(queries.length, 2);
  });

  it('guards state transitions and renewal with the claimed unexpired lease', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    });

    await finishKnowledgeBankCheckpointJob({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      sessionId: 'session-1',
      lastActivityAt: '2026-06-29T01:00:00.000Z',
      leaseOwner: 'worker-1',
      status: 'noop'
    });
    await rescheduleKnowledgeBankCheckpointJob({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      sessionId: 'session-1',
      lastActivityAt: '2026-06-29T01:00:00.000Z',
      leaseOwner: 'worker-1',
      dueAt: '2026-06-29T01:01:00.000Z',
      error: 'run_active'
    });
    await renewKnowledgeBankCheckpointJobLeaseIfCurrent({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      sessionId: 'session-1',
      lastActivityAt: '2026-06-29T01:00:00.000Z',
      leaseOwner: 'worker-1',
      leaseSeconds: 300
    });

    assert.match(queries[0].sql, /AND lease_owner = \$5/);
    assert.match(queries[0].sql, /AND lease_expires_at > NOW\(\)/);
    assert.deepEqual(queries[0].params, [
      'workspace-1',
      'target-1',
      'session-1',
      '2026-06-29T01:00:00.000Z',
      'worker-1',
      'noop',
      null,
      null
    ]);
    assert.match(queries[1].sql, /AND lease_owner = \$5/);
    assert.match(queries[1].sql, /AND lease_expires_at > NOW\(\)/);
    assert.deepEqual(queries[1].params, [
      'workspace-1',
      'target-1',
      'session-1',
      '2026-06-29T01:00:00.000Z',
      'worker-1',
      '2026-06-29T01:01:00.000Z',
      'run_active',
      null
    ]);
    assert.match(queries[2].sql, /SET lease_expires_at = NOW\(\) \+ \(\$6::int \* INTERVAL '1 second'\)/);
    assert.match(queries[2].sql, /AND job\.status = 'processing'/);
    assert.match(queries[2].sql, /AND job\.lease_owner = \$5/);
    assert.match(queries[2].sql, /AND job\.lease_expires_at > NOW\(\)/);
    assert.match(queries[2].sql, /AND s\.last_message_at = \$4::timestamptz/);
    assert.deepEqual(queries[2].params, [
      'workspace-1',
      'target-1',
      'session-1',
      '2026-06-29T01:00:00.000Z',
      'worker-1',
      300
    ]);
  });
});
