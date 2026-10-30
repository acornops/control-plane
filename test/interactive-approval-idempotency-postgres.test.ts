import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from '../src/infra/db.js';
import { canonicalJsonSha256 } from '../src/services/canonical-json.js';
import { repo } from '../src/store/repository.js';
import { createRunToolApproval, startRunToolApprovalExecution } from '../src/store/repository-run-approvals.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

type ApprovalInput = Parameters<typeof createRunToolApproval>[0];
beforeEach(resetAutomationDatabaseFixtures);
afterEach(() => mock.restoreAll());
after(closeAutomationDatabaseFixtures);

async function input(): Promise<ApprovalInput> {
  const session = await repo.addSession('workspace-1', 'cluster-1', 'user-1', 'Approval identity');
  const message = await repo.addMessage(session.id, 'user', 'Restart the approved workload.');
  const run = await repo.addRun({
    id: randomUUID(), workspaceId: 'workspace-1', targetId: 'cluster-1',
    sessionId: session.id, messageId: message.id, toolAccessMode: 'read_write',
    llmProvider: 'openai', llmModel: 'gpt-5-nano', llmReasoningSummaryMode: 'off', llmReasoningEffort: 'low',
    status: 'running', requestedAt: new Date().toISOString()
  });
  return {
    runId: run.id, sessionId: session.id, workspaceId: run.workspaceId, targetId: run.targetId,
    toolCallId: 'call-1', toolName: 'restart_workload',
    toolRef: { serverId: 'builtin:agentk', toolName: 'restart_workload' },
    arguments: { namespace: 'default', name: 'web' }, summary: 'Restart web', requestedBy: 'user-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    continuationState: { schema_version: 1, pending: { id: 'call-1', step: 2 } }
  };
}

async function snapshot(runId: string) {
  const approval = await db.query('SELECT * FROM run_tool_approvals WHERE run_id=$1 ORDER BY id', [runId]);
  const continuation = await db.query('SELECT * FROM run_continuations WHERE run_id=$1', [runId]);
  const audit = await db.query("SELECT * FROM workspace_audit_events WHERE metadata->>'runId'=$1 ORDER BY id", [runId]);
  const run = await db.query('SELECT status FROM runs WHERE id=$1', [runId]);
  return { approvals: approval.rows, continuations: continuation.rows, audits: audit.rows, run: run.rows };
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'APPROVAL_IDEMPOTENCY_CONFLICT';
}

it('exact replay preserves arguments, continuation, expiry, run state and one audit', async () => {
  const params = await input();
  const first = await createRunToolApproval(params);
  const before = await snapshot(params.runId);
  const replay = await createRunToolApproval({ ...params,
    arguments: { name: 'web', namespace: 'default' },
    continuationState: { pending: { step: 2, id: 'call-1' }, schema_version: 1 },
    expiresAt: new Date(Date.now() + 120_000).toISOString()
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(await snapshot(params.runId), before);
  assert.equal(before.audits.filter((event) => event.event_type === 'run.tool_approval_requested.v1').length, 1);
});

it('replays without optional identity or continuation fields remain read-only', async () => {
  const params = { ...await input(), targetId: undefined, requestedBy: undefined, summary: undefined, continuationState: undefined };
  await createRunToolApproval(params);
  const before = await snapshot(params.runId);
  await createRunToolApproval(params);
  assert.deepEqual(await snapshot(params.runId), before);
});

const changedIdentities: Array<[string, Partial<ApprovalInput>]> = [
  ['arguments', { arguments: { namespace: 'default', name: 'other' } }],
  ['tool alias', { toolName: 'delete_resource' }],
  ['server', { toolRef: { serverId: 'other', toolName: 'restart_workload' } }],
  ['server tool', { toolRef: { serverId: 'builtin:agentk', toolName: 'delete_resource' } }],
  ['workspace', { workspaceId: 'workspace-2' }],
  ['target', { targetId: 'cluster-2' }],
  ['requester', { requestedBy: undefined }],
  ['summary', { summary: undefined }]
];
for (const status of ['pending', 'approved', 'rejected', 'expired']) {
  it(`rejects changed identity while ${status} without modifying any persisted state`, async () => {
    const params = await input();
    const approval = await createRunToolApproval(params);
    await db.query('UPDATE run_tool_approvals SET status=$2 WHERE id=$1', [approval.id, status]);
    const before = await snapshot(params.runId);
    for (const [field, change] of changedIdentities) {
      await assert.rejects(createRunToolApproval({ ...params, ...change }), isConflict, field);
      assert.deepEqual(await snapshot(params.runId), before, field);
    }
  });
}

it('cannot replace, omit, add, resurrect or steal a continuation on replay', async () => {
  const params = await input();
  await createRunToolApproval(params);
  for (const continuationState of [undefined, { pending: 'changed' }]) {
    const before = await snapshot(params.runId);
    await assert.rejects(createRunToolApproval({ ...params, continuationState }), isConflict);
    assert.deepEqual(await snapshot(params.runId), before);
  }
  await repo.deleteRunContinuation(params.runId);
  const consumed = await snapshot(params.runId);
  await assert.rejects(createRunToolApproval(params), isConflict);
  assert.deepEqual(await snapshot(params.runId), consumed);
  await createRunToolApproval({ ...params, toolCallId: 'call-2' });
  const newer = await snapshot(params.runId);
  await assert.rejects(createRunToolApproval(params), isConflict);
  assert.deepEqual(await snapshot(params.runId), newer);
  const without = { ...await input(), continuationState: undefined };
  await createRunToolApproval(without);
  await assert.rejects(createRunToolApproval({ ...without, continuationState: {} }), isConflict);
});

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

async function waitForApprovalLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await db.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%run_tool_approvals%'`);
    if (result.rowCount) return;
    await delay(10);
  }
  assert.fail('Competing approval did not reach the database lock');
}

for (const identical of [true, false]) {
  it(`serializes ${identical ? 'identical' : 'conflicting'} concurrent creators`, { timeout: 10000 }, async () => {
    const params = await input();
    const client = await db.connect();
    const query = client.query.bind(client);
    const inserted = barrier();
    const finish = barrier();
    mock.method(client, 'query', async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql.includes('INSERT INTO run_tool_approvals')) {
        inserted.release();
        await finish.reached;
      }
      return result;
    });
    const connect = mock.method(db, 'connect', async () => { connect.mock.restore(); return client; });
    const first = createRunToolApproval(params);
    let second: Promise<unknown> | undefined;
    try {
      await inserted.reached;
      second = createRunToolApproval({ ...params, ...(identical ? {} : { arguments: { name: 'other' } }) })
        .catch((error: unknown) => error);
      await waitForApprovalLock();
    } finally {
      finish.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      mock.restoreAll();
    }
    const winner = await first;
    if (identical) assert.deepEqual(await second, winner);
    else assert.ok(isConflict(await second));
    const state = await snapshot(params.runId);
    assert.equal(state.approvals.length, 1);
    assert.equal(state.audits.filter((event) => event.event_type === 'run.tool_approval_requested.v1').length, 1);
    assert.equal(winner.argumentsDigest, canonicalJsonSha256(params.arguments));
  });
}

it('a conflicting retry racing execution start cannot change receipt intent', { timeout: 10000 }, async () => {
  const params = await input();
  const approval = await createRunToolApproval(params);
  await repo.decideRunToolApproval(approval.id, 'approved', 'user-1');
  const signing = barrier();
  const finish = barrier();
  const started = startRunToolApprovalExecution(approval.id, async (claims) => {
    assert.equal(claims.argumentsDigest, canonicalJsonSha256(params.arguments));
    assert.equal(claims.serverToolName, params.toolRef.toolName);
    signing.release();
    await finish.reached;
    return 'synthetic-receipt';
  });
  let conflicting: Promise<unknown> | undefined;
  try {
    await signing.reached;
    conflicting = createRunToolApproval({ ...params, arguments: { name: 'other' } }).catch((error: unknown) => error);
    await waitForApprovalLock();
  } finally {
    finish.release();
    await Promise.allSettled([started, ...(conflicting ? [conflicting] : [])]);
  }
  assert.ok(isConflict(await conflicting));
  assert.equal((await started)?.approval.executionStatus, 'executing');
  const persisted = await repo.getRunToolApproval(approval.id);
  assert.deepEqual(persisted?.arguments, params.arguments);
  await assert.rejects(startRunToolApprovalExecution(approval.id, async () => assert.fail('Duplicate receipt')));
});

it('rolls back the initial approval and continuation if audit persistence fails', async () => {
  const params = await input();
  const before = await snapshot(params.runId);
  const client = await db.connect();
  const query = client.query.bind(client);
  mock.method(client, 'query', async (sql: string, values?: unknown[]) => {
    if (sql.includes('INSERT INTO workspace_audit_events')) throw new Error('Synthetic audit failure');
    return query(sql, values);
  });
  const connect = mock.method(db, 'connect', async () => { connect.mock.restore(); return client; });
  await assert.rejects(createRunToolApproval(params), /Synthetic audit failure/);
  mock.restoreAll();
  assert.deepEqual(await snapshot(params.runId), before);
});
