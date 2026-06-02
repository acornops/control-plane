import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listWorkspaceAuditEvents } from '../src/controllers/workspaces/audit-controller.js';
import { repo } from '../src/store/repository.js';

const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalListWorkspaceAuditEvents = repo.listWorkspaceAuditEvents;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.listWorkspaceAuditEvents = originalListWorkspaceAuditEvents;
});

function createRequest(query: Record<string, string | undefined> = {}) {
  return {
    params: { workspaceId: 'workspace-1' },
    query,
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    }
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

describe('workspace audit log controller', () => {
  it('rejects invalid filters instead of widening the audit query', async () => {
    repo.getWorkspaceRole = async () => 'auditor';
    let listed = false;
    repo.listWorkspaceAuditEvents = async () => {
      listed = true;
      return { items: [] };
    };

    for (const query of [
      { category: 'everything' },
      { eventType: '   ' },
      { actorUserId: '   ' },
      { targetType: '   ' },
      { from: 'not-a-date' },
      { to: 'not-a-date' },
      { from: '2026-05-30T12:00:00.000Z', to: '2026-05-30T11:00:00.000Z' }
    ]) {
      const res = createResponse();
      await listWorkspaceAuditEvents(createRequest(query) as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 400);
      assert.equal((res.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    }
    assert.equal(listed, false);
  });

  it('keeps valid audit filters scoped to the requested workspace', async () => {
    repo.getWorkspaceRole = async () => 'auditor';
    let observedWorkspaceId = '';
    let observedCategory = '';
    repo.listWorkspaceAuditEvents = async (workspaceId, options) => {
      observedWorkspaceId = workspaceId;
      observedCategory = options.category || '';
      return { items: [] };
    };
    const res = createResponse();

    await listWorkspaceAuditEvents(createRequest({ category: 'membership' }) as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal(observedWorkspaceId, 'workspace-1');
    assert.equal(observedCategory, 'membership');
  });

  it('serializes audit event operation in list responses', async () => {
    repo.getWorkspaceRole = async () => 'auditor';
    repo.listWorkspaceAuditEvents = async () => ({
      items: [
        {
          id: 'audit-1',
          workspaceId: 'workspace-1',
          category: 'tool',
          eventType: 'tool.called.v1',
          operation: 'read',
          actor: { type: 'system' },
          target: { type: 'tool_call', id: 'target-1', name: 'get_resource_logs' },
          summary: 'Tool called',
          metadata: { toolName: 'get_resource_logs' },
          occurredAt: '2026-06-01T00:00:00.000Z'
        }
      ]
    });
    const res = createResponse();

    await listWorkspaceAuditEvents(createRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { items: Array<{ operation: string }> }).items[0].operation, 'read');
  });
});
