import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { rotateTargetAgentKey } from '../src/controllers/admin-target-run-controller.js';
import { repo } from '../src/store/repository.js';

afterEach(() => mock.restoreAll());

describe('admin AgentV credential replacement', () => {
  it('issues one-use replacement enrollment without exposing or auditing a durable key', async () => {
    const target = {
      id: 'vm-1', workspaceId: 'workspace-1', targetType: 'virtual_machine' as const,
      name: 'production-vm', status: 'online' as const, createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z'
    };
    mock.method(repo, 'getTargetById', async () => target);
    mock.method(repo, 'getTargetAgentRegistration', async () => ({
      targetId: target.id, targetType: target.targetType, workspaceId: target.workspaceId,
      agentKeyHash: 'active-hash', keyVersion: 1
    }));
    mock.method(repo, 'getVirtualMachine', async () => ({
      ...target,
      hostname: 'production-vm',
      osFamily: 'linux' as const,
      serviceManager: 'systemd' as const,
      allowedLogSources: ['acornops-agentv.service'],
      agentAccessMode: 'read_write' as const,
      restartServices: ['nginx.service']
    }));
    let enrollmentInput: Record<string, unknown> | undefined;
    mock.method(repo.agentv, 'createAgentVEnrollment', async (input) => {
      enrollmentInput = input as unknown as Record<string, unknown>;
      return true;
    });
    const audits: Array<Record<string, unknown>> = [];
    mock.method(repo, 'insertAdminAuditEvent', async (event) => {
      audits.push(event as unknown as Record<string, unknown>);
      return { id: `admin-event-${audits.length}`, ...event } as never;
    });
    mock.method(repo, 'insertWorkspaceAuditEvent', async (event) => {
      audits.push(event as unknown as Record<string, unknown>);
      return event as never;
    });
    const res = {
      statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name] = value; return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; }
    };
    const req = {
      admin: { tokenId: 'platform-admin-console', scopes: ['admin:*'], credential: { type: 'admin_token' } },
      params: { targetId: target.id }, body: { reason: 'credential recovery test', ticketRef: 'OPS-123' },
      header: () => undefined, ip: '127.0.0.1', socket: {}, res: { locals: { requestId: 'req-admin-test' } }
    };

    await rotateTargetAgentKey(req as never, res as never, (error?: unknown) => { if (error) throw error; });

    assert.equal(res.statusCode, 200);
    const body = res.body as { agentKey?: unknown; installInstructions: { command: string; enrollmentExpiresAt?: string } };
    assert.equal(body.agentKey, undefined);
    assert.match(body.installInstructions.command, /--enrollment-token 'aev_/);
    assert.match(body.installInstructions.command, /--replace-credential/);
    assert.doesNotMatch(body.installInstructions.command, /--agent-key/);
    assert.equal(typeof body.installInstructions.enrollmentExpiresAt, 'string');
    assert.equal(enrollmentInput?.purpose, 'replace');
    assert.equal(enrollmentInput?.createdBy, 'admin:platform-admin-console');
    assert.deepEqual(enrollmentInput?.accessPolicy, {
      accessMode: 'read_write', restartServices: ['nginx.service']
    });
    assert.equal(JSON.stringify(audits).includes('aev_'), false);
  });
});
