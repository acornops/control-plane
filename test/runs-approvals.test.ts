import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decideRunApproval } from '../src/controllers/runs-controller.js';
import { repo } from '../src/store/repository.js';
import type { Run, RunToolApproval } from '../src/types/domain.js';

const originalGetRun = repo.getRun;
const originalGetRunRequestProvenance = repo.getRunRequestProvenance;
const originalGetRunToolApproval = repo.getRunToolApproval;
const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalGetExternalIntegrationWorkspaceGrant = repo.getExternalIntegrationWorkspaceGrant;
const originalDecideRunToolApproval = repo.decideRunToolApproval;
const originalInsertTargetChatActivityEvent = repo.insertTargetChatActivityEvent;
const originalInsertWorkspaceAuditEvent = repo.insertWorkspaceAuditEvent;
const originalEnqueueWebhookOutboxEvent = repo.enqueueWebhookOutboxEvent;

beforeEach(() => {
  repo.insertTargetChatActivityEvent = async (event) => ({
    id: 'activity-event-1',
    workspaceId: event.workspaceId,
    targetId: event.targetId,
    targetType: event.targetType,
    sessionId: event.sessionId,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    type: event.type,
    payload: event.payload ?? {},
    createdAt: '2026-05-06T00:00:00.000Z'
  });
});

afterEach(() => {
  repo.getRun = originalGetRun;
  repo.getRunRequestProvenance = originalGetRunRequestProvenance;
  repo.getRunToolApproval = originalGetRunToolApproval;
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getExternalIntegrationWorkspaceGrant = originalGetExternalIntegrationWorkspaceGrant;
  repo.decideRunToolApproval = originalDecideRunToolApproval;
  repo.insertTargetChatActivityEvent = originalInsertTargetChatActivityEvent;
  repo.insertWorkspaceAuditEvent = originalInsertWorkspaceAuditEvent;
  repo.enqueueWebhookOutboxEvent = originalEnqueueWebhookOutboxEvent;
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

function createExternalIntegrationRequest(linkId = 'link-1') {
  return {
    params: { runId: 'run-1', approvalId: 'approval-1' },
    body: { decision: 'approved' },
    auth: {
      userId: 'user-1',
      credential: {
        type: 'external_integration' as const,
        linkId,
        integrationId: 'external-chat',
        provider: 'external',
        externalUserId: 'external-user-1'
      }
    },
    externalIntegrationClient: {
      allowedCapabilities: ['read_workspace_data', 'create_sessions', 'create_read_write_runs']
    }
  };
}

function installExternalIntegrationApprovalAccess(): void {
  repo.getWorkspaceRole = async () => 'admin';
  repo.getExternalIntegrationWorkspaceGrant = async () => ({
    workspaceId: 'workspace-1',
    capabilities: ['read_workspace_data', 'create_sessions', 'create_read_write_runs'],
    grantedByUserId: 'user-1',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z'
  });
}

describe('run approval decisions', () => {
  it('allows the same linked external integration to approve its troubleshooting write', async () => {
    repo.getRun = async () => createRun();
    repo.getRunRequestProvenance = async () => ({
      actorType: 'external_integration',
      externalIntegrationLinkId: 'link-1',
      externalIntegrationClientId: 'external-chat'
    });
    repo.getRunToolApproval = async () => createApproval({ status: 'pending', requestedBy: 'user-1' });
    repo.decideRunToolApproval = async () => createApproval({
      status: 'approved',
      decision: 'approved',
      requestedBy: 'user-1',
      decidedBy: 'user-1'
    });
    installExternalIntegrationApprovalAccess();
    let auditActor: { actorType?: string; actorUserId?: string | null; actorTokenId?: string | null } | undefined;
    repo.insertWorkspaceAuditEvent = async (input) => {
      auditActor = input;
      return null;
    };
    repo.enqueueWebhookOutboxEvent = async () => null;
    const res = createResponse();

    await decideRunApproval(createExternalIntegrationRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as RunToolApproval).status, 'approved');
    assert.equal(auditActor?.actorType, 'external_integration');
    assert.equal(auditActor?.actorUserId, 'user-1');
    assert.equal(auditActor?.actorTokenId, 'external-chat');
  });

  it('denies an external integration approval when the run was created in the browser', async () => {
    repo.getRun = async () => createRun();
    repo.getRunRequestProvenance = async () => ({ actorType: 'user' });
    installExternalIntegrationApprovalAccess();
    const res = createResponse();

    await decideRunApproval(createExternalIntegrationRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.equal(
      (res.body as { error: { code: string } }).error.code,
      'EXTERNAL_INTEGRATION_APPROVAL_NOT_OWNED'
    );
  });

  it('denies an external integration approval when the run originated from another link', async () => {
    repo.getRun = async () => createRun();
    repo.getRunRequestProvenance = async () => ({
      actorType: 'external_integration',
      externalIntegrationLinkId: 'link-2',
      externalIntegrationClientId: 'external-chat'
    });
    installExternalIntegrationApprovalAccess();
    let decisionAttempted = false;
    repo.decideRunToolApproval = async () => {
      decisionAttempted = true;
      return null;
    };
    const res = createResponse();

    await decideRunApproval(createExternalIntegrationRequest('link-1') as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.equal(
      (res.body as { error: { code: string } }).error.code,
      'EXTERNAL_INTEGRATION_APPROVAL_NOT_OWNED'
    );
    assert.equal(decisionAttempted, false);
  });

  it('requires effective create_read_write_runs for an external integration approval', async () => {
    repo.getRun = async () => createRun();
    repo.getRunRequestProvenance = async () => ({
      actorType: 'external_integration',
      externalIntegrationLinkId: 'link-1',
      externalIntegrationClientId: 'external-chat'
    });
    repo.getRunToolApproval = async () => createApproval({ status: 'pending', requestedBy: 'user-1' });
    repo.getWorkspaceRole = async () => 'operator';
    repo.getExternalIntegrationWorkspaceGrant = async () => ({
      workspaceId: 'workspace-1',
      capabilities: ['read_workspace_data', 'create_sessions', 'create_read_write_runs'],
      grantedByUserId: 'user-1',
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z'
    });
    const res = createResponse();

    await decideRunApproval(createExternalIntegrationRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.equal((res.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });

  it('does not allow external integrations to fall through to Workflow or Agent approvals', async () => {
    repo.getRun = async () => null;
    const res = createResponse();

    await decideRunApproval(createExternalIntegrationRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 404);
    assert.equal((res.body as { error: { code: string } }).error.code, 'NOT_FOUND');
  });

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
