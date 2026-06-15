import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { decideRunApproval } from '../src/controllers/runs-controller.js';
import { repo } from '../src/store/repository.js';
import type { Run, RunToolApproval } from '../src/types/domain.js';

const originalGetRun = repo.getRun;
const originalGetRunToolApproval = repo.getRunToolApproval;
const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalDecideRunToolApproval = repo.decideRunToolApproval;

afterEach(() => {
  repo.getRun = originalGetRun;
  repo.getRunToolApproval = originalGetRunToolApproval;
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.decideRunToolApproval = originalDecideRunToolApproval;
});

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    toolAccessMode: 'read_write',
    status: 'completed',
    requestedAt: '2026-05-06T00:00:00.000Z',
    ...overrides
  };
}

function createApproval(overrides: Partial<RunToolApproval> = {}): RunToolApproval {
  return {
    id: 'approval-1',
    runId: 'run-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    toolCallId: 'call-1',
    toolName: 'restart_workload',
    summary: 'Restart workload default/web.',
    arguments: { namespace: 'default', name: 'web' },
    status: 'expired',
    executionStatus: 'not_started',
    expiresAt: '2026-05-06T00:00:00.000Z',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    ...overrides
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

function createAuth(userId = 'user-1') {
  return {
    userId,
    credential: { type: 'session' as const, sessionId: 'session-1' }
  };
}

describe('run approval decisions', () => {
  it('rejects decisions for expired approvals instead of treating them as idempotent', async () => {
    repo.getRun = async () => createRun();
    repo.getWorkspaceRole = async () => 'admin';
    repo.getRunToolApproval = async () => createApproval();

    const req = {
      params: { runId: 'run-1', approvalId: 'approval-1' },
      body: { decision: 'approved' },
      auth: createAuth()
    };
    const res = createResponse();

    await decideRunApproval(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 409);
    assert.deepEqual((res.body as { error: { code: string } }).error.code, 'APPROVAL_ALREADY_DECIDED');
  });

  it('keeps repeated matching decisions idempotent', async () => {
    repo.getRun = async () => createRun();
    repo.getWorkspaceRole = async () => 'admin';
    repo.getRunToolApproval = async () => createApproval({ status: 'approved', decision: 'approved' });

    const req = {
      params: { runId: 'run-1', approvalId: 'approval-1' },
      body: { decision: 'approved' },
      auth: createAuth()
    };
    const res = createResponse();

    await decideRunApproval(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as RunToolApproval).status, 'approved');
  });

  it('returns conflict when a pending approval expires during the decision write', async () => {
    repo.getRun = async () => createRun();
    repo.getRunToolApproval = async () => createApproval({ status: 'pending' });
    repo.getWorkspaceRole = async () => 'admin';
    repo.decideRunToolApproval = async () => createApproval({ status: 'expired' });

    const req = {
      params: { runId: 'run-1', approvalId: 'approval-1' },
      body: { decision: 'approved' },
      auth: createAuth()
    };
    const res = createResponse();

    await decideRunApproval(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 409);
    assert.deepEqual((res.body as { error: { code: string } }).error.code, 'APPROVAL_EXPIRED');
    assert.equal((res.body as { approval: RunToolApproval }).approval.status, 'expired');
  });
});
