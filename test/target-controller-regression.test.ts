import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createSession, deleteSession, postMessage } from '../src/controllers/sessions-controller.js';
import {
  createTargetMcpServerForTarget,
  listTargetMcpCatalog,
  listTargetMcpServers,
  listTargetMcpServerTools,
} from '../src/controllers/workspaces/target-tool-controller.js';
import {
  parseTargetMcpServerCreate,
  parseTargetMcpServerUpdate,
  targetMcpToolSettingsSchema
} from '../src/controllers/workspaces/target-mcp-helpers.js';
import { getVirtualMachineLogs } from '../src/controllers/workspaces/virtual-machine-controller.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { syncTooling } from '../src/controllers/internal-tooling-controller.js';
import { webhooks, type WebhookEventInput } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import { createToolApprovalSchema, internalToolingSyncSchema } from '../src/types/contracts.js';
import type { ChatSession } from '../src/types/domain.js';
import {
  callController,
  createMessage,
  createRequest,
  createRun,
  createSessionRecord,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);
describe('target controller regressions', () => {
  it('rejects malformed and unknown target MCP mutation fields', () => {
    assert.equal(parseTargetMcpServerCreate({
      name: 'server', url: 'https://mcp.example.test', auth: { type: 'unsupported' }
    }).success, false);
    assert.equal(parseTargetMcpServerCreate({
      name: 'server', url: 'https://mcp.example.test', credential: 'secret'
    }).success, false);
    assert.equal(parseTargetMcpServerUpdate({ enabled: 'false' }).success, false);
    assert.equal(parseTargetMcpServerUpdate({ ignored: true }).success, false);
    assert.equal(targetMcpToolSettingsSchema.safeParse({ enabled: false, ignored: true }).success, false);
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

  it('normalizes optional tool approval summaries at the contract boundary', () => {
    const parsed = createToolApprovalSchema.safeParse({
      toolCallId: 'call-1',
      toolName: 'restart_workload',
      toolRef: { serverId: 'server-1', toolName: 'restart_workload' },
      summary: '  Restart\u0007\n\tDeployment   default/api.  ',
      arguments: { namespace: 'default', name: 'api' }
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.summary, 'Restart Deployment default/api.');
  });

  it('treats blank tool approval summaries as omitted for compatibility', () => {
    const parsed = createToolApprovalSchema.safeParse({
      toolCallId: 'call-1',
      toolName: 'restart_workload',
      toolRef: { serverId: 'server-1', toolName: 'restart_workload' },
      summary: '  \n\t  ',
      arguments: { namespace: 'default', name: 'api' }
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.summary, undefined);
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
    repo.getTargetAgentRegistration = async () => ({ capabilities: ['read', 'write'] }) as never;
    repo.listTargetToolOverrides = async () => ({});
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
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      if (String(input).includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (String(input).includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const allowed = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_only' })
    );

    assert.equal(allowed.statusCode, 202);
    assert.deepEqual(allowed.body, {
      message_id: 'message-1',
      run_id: 'run-1',
      runtimeSelection: {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        reasoningEffort: 'low'
      }
    });
  });
  it('records durable target chat activity after deleting a session', async () => {
    installWorkspace('admin');
    const session = createSessionRecord({ id: 'session-delete', targetId: 'target-1', targetType: 'virtual_machine', clusterId: undefined });
    const recorded: unknown[] = [];
    repo.getSession = async () => session;
    repo.deleteSession = async () => true;
    repo.insertTargetChatActivityEvent = async (event) => {
      recorded.push(event);
      return {
        id: 'activity-event-1',
        workspaceId: event.workspaceId,
        targetId: event.targetId,
        targetType: event.targetType,
        sessionId: event.sessionId,
        type: event.type,
        payload: event.payload ?? {},
        createdAt: '2026-05-24T00:00:00.000Z'
      };
    };

    const response = await callController(
      deleteSession,
      createRequest({ sessionId: 'session-delete' })
    );

    assert.equal(response.statusCode, 204);
    assert.equal(recorded.length, 1);
    const activity = recorded[0] as {
      workspaceId: string;
      targetId: string;
      targetType: string;
      sessionId: string;
      type: string;
      payload: { deletedBy: string; deletedAt: string };
    };
    assert.deepEqual(activity, {
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'virtual_machine',
      sessionId: 'session-delete',
      type: 'session.deleted',
      payload: {
        deletedBy: 'user-1',
        deletedAt: activity.payload.deletedAt
      }
    });
    assert.match(activity.payload.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('routes target MCP catalogs and server reads by persisted target type', async () => {
    installWorkspace('viewer');
    repo.getCluster = async () => {
      throw new Error('target tool route should not require Kubernetes cluster lookup');
    };
    repo.getTargetAgentRegistration = async () => null;
    repo.listTargetToolOverrides = async () => ({});

    const capturedUrls: string[] = [];
    mock.method(globalThis, 'fetch', async (input) => {
      capturedUrls.push(String(input));
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const catalog = await callController(
      listTargetMcpCatalog,
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

  it('does not synthesize a built-in server when gateway server metadata is absent', async () => {
    installWorkspace('viewer');
    repo.getTargetAgentRegistration = async () => null;
    repo.listTargetToolOverrides = async () => ({});

    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(
      listTargetMcpServerTools,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'builtin-system-server' })
    );

    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error: { code: string } }).error.code, 'NOT_FOUND');
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
    let toolArguments: Record<string, unknown> | undefined;
    repo.insertWorkspaceAuditEvent = async (event) => {
      audits.push(event);
      return {
        id: 'audit-event-1',
        workspaceId: event.workspaceId,
        category: event.category,
        eventType: event.eventType,
        actor: { type: 'user', userId: 'user-1' },
        object: { type: event.objectType, id: event.objectId, name: event.objectName },
        summary: event.summary,
        metadata: event.metadata ?? {},
        occurredAt: '2026-05-24T00:00:00.000Z'
      };
    };
    mock.method(agentGateway, 'callAgentTool', async (_targetId, _toolName, args) => {
      toolArguments = args;
      return { entries: [{ source: 'journald', message: 'secret=should-not-be-audited' }] };
    });

    const request = createRequest({ workspaceId: 'workspace-1', vmId: 'target-1' });
    request.query = { source: 'journald', unit: 'acornops-agentv.service' };

    const allowed = await callController(
      getVirtualMachineLogs,
      request
    );

    assert.equal(allowed.statusCode, 200);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata?.toolName, 'query_logs');
    assert.equal(JSON.stringify(audits[0].metadata).includes('should-not-be-audited'), false);
    assert.equal(toolArguments?.unit, 'acornops-agentv.service');
    assert.equal(Object.hasOwn(toolArguments || {}, 'source'), false);
  });

});
