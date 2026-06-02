import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createToolApproval } from '../src/controllers/internal-approval-controller.js';
import { createSession, getTargetChatActivity, postMessage } from '../src/controllers/sessions-controller.js';
import { listTargets } from '../src/controllers/workspaces/target-controller.js';
import {
  createTargetMcpServerForTarget,
  listTargetMcpServers,
  listTargetToolsCatalog
} from '../src/controllers/workspaces/target-tool-controller.js';
import { getVirtualMachineLogs } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { syncTooling } from '../src/controllers/internal-tooling-controller.js';
import { webhooks, type WebhookEventInput } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import { internalToolingSyncSchema } from '../src/types/contracts.js';
import type { ChatSession } from '../src/types/domain.js';
import {
  callController,
  createApproval,
  createMessage,
  createRequest,
  createRun,
  createSessionRecord,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target controller regressions', () => {
  it('rejects invalid target type filters instead of silently widening the target list', async () => {
    installWorkspace('viewer');
    const req = createRequest({ workspaceId: 'workspace-1' });
    req.query = { targetType: 'database' };

    const denied = await callController(listTargets, req);

    assert.equal(denied.statusCode, 400);
    assert.equal((denied.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    assert.match((denied.body as { error: { message: string } }).error.message, /targetType/);
  });

  it('authorizes target session routes through generic targets', async () => {
    installWorkspace('operator');
    repo.getCluster = async () => {
      throw new Error('target session route should not require Kubernetes cluster lookup');
    };
    repo.addSession = async (_workspaceId, targetId) =>
      createSessionRecord({ targetId, targetType: 'virtual_machine', clusterId: undefined });

    const allowed = await callController(
      createSession,
      createRequest({ workspaceId: 'workspace-1', targetId: 'target-1' }, { title: 'Session' })
    );

    assert.equal(allowed.statusCode, 201);
    assert.equal((allowed.body as ChatSession).targetId, 'target-1');
    assert.equal((allowed.body as ChatSession).targetType, 'virtual_machine');
    assert.equal((allowed.body as ChatSession).clusterId, undefined);
  });

  it('emits Kubernetes cluster scope when sessions are created through target routes', async () => {
    installWorkspace('operator');
    const emitted: WebhookEventInput[] = [];
    mock.method(webhooks, 'emit', (event: WebhookEventInput) => {
      emitted.push(event);
    });
    repo.getCluster = async () => {
      throw new Error('target session route should not require Kubernetes cluster lookup');
    };
    repo.addSession = async (_workspaceId, targetId) =>
      createSessionRecord({ targetId, targetType: 'kubernetes', clusterId: targetId });

    const allowed = await callController(
      createSession,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' }, { title: 'Session' })
    );

    assert.equal(allowed.statusCode, 201);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].targetId, 'cluster-1');
    assert.equal(emitted[0].targetType, 'kubernetes');
    assert.equal(emitted[0].clusterId, 'cluster-1');
  });

  it('requires complete target scope for targeted tooling sync requests', () => {
    assert.equal(internalToolingSyncSchema.safeParse({}).success, true);
    assert.equal(
      internalToolingSyncSchema.safeParse({
        workspaceId: 'workspace-1',
        targetId: 'cluster-1',
        targetType: 'kubernetes'
      }).success,
      true
    );
    assert.equal(
      internalToolingSyncSchema.safeParse({
        workspaceId: 'workspace-1',
        targetId: 'cluster-1'
      }).success,
      false
    );
  });

  it('does not infer Kubernetes target type for direct tooling sync calls', async () => {
    const denied = await callController(
      syncTooling,
      createRequest({}, { workspaceId: 'workspace-1', targetId: 'cluster-1' })
    );

    assert.equal(denied.statusCode, 400);
    assert.equal((denied.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
  });

  it('verifies direct Kubernetes tooling sync requests against the persisted target type', async () => {
    installWorkspace('admin');

    const denied = await callController(
      syncTooling,
      createRequest({}, { workspaceId: 'workspace-1', targetId: 'target-1', targetType: 'kubernetes' })
    );

    assert.equal(denied.statusCode, 400);
    assert.equal((denied.body as { error: { code: string } }).error.code, 'TARGET_TYPE_MISMATCH');
  });

  it('allows read-only VM run creation through target-scoped sessions', async () => {
    installWorkspace('operator');
    repo.getSession = async () =>
      createSessionRecord({ targetId: 'target-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.createRunFromUserMessage = async () => ({
      message: createMessage(),
      run: createRun({
        targetId: 'target-1',
        targetType: 'virtual_machine',
        clusterId: undefined,
        toolAccessMode: 'read_only'
      }),
      idempotent: true
    });

    const allowed = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_only' })
    );

    assert.equal(allowed.statusCode, 202);
    assert.deepEqual(allowed.body, { message_id: 'message-1', run_id: 'run-1' });
  });

  it('returns recent target chat activity for readable target sessions', async () => {
    installWorkspace('viewer');
    let capturedWindowSeconds = 0;
    repo.listRecentTargetChatActivity = async (_workspaceId: string, targetId: string, windowSeconds: number) => {
      capturedWindowSeconds = windowSeconds;
      return [
        {
          sessionId: 'session-1',
          title: 'Session',
          createdBy: 'user-1',
          createdByUser: { id: 'user-1', displayName: 'User One' },
          lastActivityAt: '2026-05-24T00:01:00.000Z',
          lastRunId: 'run-1',
          lastRunStatus: 'waiting_for_approval',
          activeRun: {
            runId: 'run-1',
            status: 'waiting_for_approval',
            toolAccessMode: 'read_write',
            requestedAt: '2026-05-24T00:00:30.000Z'
          },
          hasActiveRun: true,
          hasRecentWriteCapableRun: true,
          latestToolAccessMode: 'read_write'
        }
      ];
    };

    const allowed = await callController(
      getTargetChatActivity,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' })
    );

    assert.equal(allowed.statusCode, 200);
    assert.equal(capturedWindowSeconds, 300);
    assert.equal((allowed.body as { targetName: string }).targetName, 'cluster');
    assert.equal((allowed.body as { recentActivity: unknown[] }).recentActivity.length, 1);
  });

  it('clamps target chat activity windows to the supported range', async () => {
    installWorkspace('viewer');
    let capturedWindowSeconds = 0;
    repo.listRecentTargetChatActivity = async (_workspaceId: string, _targetId: string, windowSeconds: number) => {
      capturedWindowSeconds = windowSeconds;
      return [];
    };

    const request = createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' });
    request.query = { windowSeconds: '99999' };
    const allowed = await callController(getTargetChatActivity, request);

    assert.equal(allowed.statusCode, 200);
    assert.equal(capturedWindowSeconds, 3600);
    assert.equal((allowed.body as { windowSeconds: number }).windowSeconds, 3600);
  });

  it('routes target MCP catalogs and server reads by persisted target type', async () => {
    installWorkspace('viewer');
    repo.getCluster = async () => {
      throw new Error('target tool route should not require Kubernetes cluster lookup');
    };
    repo.listTargetToolOverrides = async () => ({});

    const capturedUrls: string[] = [];
    mock.method(globalThis, 'fetch', async (input) => {
      capturedUrls.push(String(input));
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const catalog = await callController(
      listTargetToolsCatalog,
      createRequest({ workspaceId: 'workspace-1', targetId: 'target-1' })
    );
    assert.equal(catalog.statusCode, 200);
    assert.equal((catalog.body as { targetId: string }).targetId, 'target-1');
    assert.equal((catalog.body as { targetType: string }).targetType, 'virtual_machine');

    const servers = await callController(
      listTargetMcpServers,
      createRequest({ workspaceId: 'workspace-1', targetId: 'target-1' })
    );
    assert.equal(servers.statusCode, 200);
    assert.deepEqual(servers.body, []);
    assert(capturedUrls.some((url) => /target_id=target-1/.test(url)));
    assert(capturedUrls.every((url) => /target_type=virtual_machine/.test(url)));
  });

  it('preserves the Kubernetes cluster alias on target-scoped MCP mutation webhooks', async () => {
    installWorkspace('admin');
    const emitted: WebhookEventInput[] = [];
    mock.method(webhooks, 'emit', (event: WebhookEventInput) => {
      emitted.push(event);
    });
    let createdBody: Record<string, unknown> | undefined;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/internal/mcp/servers') && init?.method === 'POST') {
        createdBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          id: 'server-1',
          workspace_id: 'workspace-1',
          target_id: 'cluster-1',
          target_type: 'kubernetes',
          server_name: 'ops-mcp',
          server_url: 'https://mcp.example.test',
          enabled: true,
          auth_type: 'none',
          tools: []
        }), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const created = await callController(
      createTargetMcpServerForTarget,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1' },
        { name: 'ops-mcp', url: 'https://mcp.example.test', enabled: true, auth: { type: 'none' } }
      )
    );

    assert.equal(created.statusCode, 201);
    assert.equal(createdBody?.target_type, 'kubernetes');
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]?.targetId, 'cluster-1');
    assert.equal(emitted[0]?.targetType, 'kubernetes');
    assert.equal(emitted[0]?.clusterId, 'cluster-1');
    assert.equal(emitted[1]?.clusterId, 'cluster-1');
  });

  it('rejects Kubernetes targets on VM-specific log routes before calling an agent tool', async () => {
    installWorkspace('operator');
    const callAgentTool = mock.method(agentGateway, 'callAgentTool', async () => ({ entries: [] }));

    const denied = await callController(
      getVirtualMachineLogs,
      createRequest({ workspaceId: 'workspace-1', vmId: 'cluster-1' })
    );

    assert.equal(denied.statusCode, 404);
    assert.equal((denied.body as { error: { code: string } }).error.code, 'NOT_FOUND');
    assert.equal(callAgentTool.mock.callCount(), 0);
  });

  it('audits VM log reads without persisting returned log entries', async () => {
    installWorkspace('operator');
    const audits: Array<{ metadata?: Record<string, unknown> }> = [];
    repo.insertWorkspaceAuditEvent = async (event) => {
      audits.push(event);
      return {
        id: 'audit-event-1',
        workspaceId: event.workspaceId,
        category: event.category,
        eventType: event.eventType,
        actor: { type: 'user', userId: 'user-1' },
        target: { type: event.targetType, id: event.targetId, name: event.targetName },
        summary: event.summary,
        metadata: event.metadata ?? {},
        occurredAt: '2026-05-24T00:00:00.000Z'
      };
    };
    mock.method(agentGateway, 'callAgentTool', async () => ({
      entries: [{ source: 'journald', message: 'secret=should-not-be-audited' }]
    }));

    const allowed = await callController(
      getVirtualMachineLogs,
      createRequest({ workspaceId: 'workspace-1', vmId: 'target-1' })
    );

    assert.equal(allowed.statusCode, 200);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata?.toolName, 'get_logs');
    assert.equal(JSON.stringify(audits[0].metadata).includes('should-not-be-audited'), false);
  });

  it('creates tool approvals against the run target id without forcing a Kubernetes cluster alias', async () => {
    const emitted: WebhookEventInput[] = [];
    let capturedApprovalParams: { targetId?: string; clusterId?: string } | undefined;
    mock.method(webhooks, 'emit', (event: WebhookEventInput) => {
      emitted.push(event);
    });
    repo.getRun = async () =>
      createRun({
        targetId: 'vm-1',
        targetType: 'virtual_machine',
        clusterId: 'vm-1',
        toolAccessMode: 'read_write'
      });
    repo.getSession = async () =>
      createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.createRunToolApproval = async (params) => {
      capturedApprovalParams = params;
      return createApproval({
        targetId: params.targetId,
        targetType: 'virtual_machine',
        clusterId: params.targetId
      });
    };

    const created = await callController(
      createToolApproval,
      createRequest(
        { runId: 'run-1' },
        {
          toolCallId: 'call-1',
          toolName: 'vm.restart_service',
          arguments: { service: 'nginx' }
        }
      )
    );

    assert.equal(created.statusCode, 201);
    assert.equal(capturedApprovalParams?.targetId, 'vm-1');
    assert.equal(capturedApprovalParams?.clusterId, undefined);
    assert.equal(emitted[0]?.targetId, 'vm-1');
    assert.equal(emitted[0]?.targetType, 'virtual_machine');
    assert.equal(emitted[0]?.clusterId, undefined);
  });
});
