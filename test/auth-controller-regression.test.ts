import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { agentGateway } from '../src/agent/ws-server.js';
import { createSession, postMessage } from '../src/controllers/sessions-controller.js';
import { cancelRun, decideRunApproval } from '../src/controllers/runs-controller.js';
import { rotateAgentKey } from '../src/controllers/workspaces/kubernetes-cluster-controller.js';
import {
  createTargetMcpServerForTarget,
  updateTargetMcpServerToolSettings
} from '../src/controllers/workspaces/target-tool-controller.js';
import { createWebhook, deleteWebhook } from '../src/controllers/webhooks-controller.js';
import { logger } from '../src/logger.js';
import { repo } from '../src/store/repository.js';
import type { TargetAgentRegistration, RunContinuation } from '../src/types/domain.js';
import {
  callController,
  createApproval,
  createExternalIntegrationRequest,
  createMessage,
  createRequest,
  createRun,
  createSessionRecord,
  createWorkspaceAiCredentialStatusResponse,
  createWebhookSubscription,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('controller authorization regressions', () => {
  it('requires create_sessions to create sessions', async () => {
    installWorkspace('viewer');
    const denied = await callController(
      createSession,
      createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }, { title: 'Session' })
    );
    assert.equal(denied.statusCode, 403);

    installWorkspace('operator');
    repo.addSession = async () => createSessionRecord();
    const allowed = await callController(
      createSession,
      createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }, { title: 'Session' })
    );
    assert.equal(allowed.statusCode, 201);
  });

  it('allows external integration credentials to create read-only assistant runs by default', async () => {
    installWorkspace('operator');
    repo.addSession = async () => createSessionRecord();
    const createdSession = await callController(
      createSession,
      createExternalIntegrationRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }, { title: 'Session' })
    );
    assert.equal(createdSession.statusCode, 201);

    repo.getSession = async () => createSessionRecord();
    repo.createRunFromUserMessage = async (_input) => ({
      message: createMessage(),
      run: createRun({ toolAccessMode: 'read_only' }),
      idempotent: true
    });
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const readOnlyRun = await callController(
      postMessage,
      createExternalIntegrationRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_only' })
    );
    assert.equal(readOnlyRun.statusCode, 202);

    const readWriteRun = await callController(
      postMessage,
      createExternalIntegrationRequest({ sessionId: 'session-1' }, { content: 'change it', toolAccessMode: 'read_write' })
    );
    assert.equal(readWriteRun.statusCode, 403);
  });

  it('allows external integration credentials to request read-write runs only after explicit client and workspace grant opt-in', async () => {
    installWorkspace('admin');
    repo.getExternalIntegrationWorkspaceGrant = async () => ({
      workspaceId: 'workspace-1',
      capabilities: ['read_workspace_data', 'create_sessions', 'create_read_write_runs'],
      grantedByUserId: 'user-1',
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:00:00.000Z'
    });
    repo.getSession = async () => createSessionRecord();
    let requestProvenance: { actorType: string; externalIntegrationLinkId?: string;
      externalIntegrationClientId?: string } | undefined;
    repo.createRunFromUserMessage = async (input) => {
      requestProvenance = input.requestProvenance;
      return {
        message: createMessage(),
        run: createRun({ toolAccessMode: 'read_write' }),
        idempotent: true
      };
    };
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const req = createExternalIntegrationRequest(
      { sessionId: 'session-1' },
      { content: 'restart payments-api if required', toolAccessMode: 'read_write' }
    );
    (req as typeof req & { externalIntegrationClient: { allowedCapabilities: string[] } }).externalIntegrationClient = {
      allowedCapabilities: ['read_workspace_data', 'create_sessions', 'create_read_write_runs']
    };

    const allowed = await callController(postMessage, req);
    assert.equal(allowed.statusCode, 202);
    assert.deepEqual(requestProvenance, {
      actorType: 'external_integration',
      externalIntegrationLinkId: 'link-1',
      externalIntegrationClientId: 'external-chat'
    });
  });

  it('does not fail completed session creation when nontransactional audit logging fails', async () => {
    installWorkspace('operator');
    repo.addSession = async () => createSessionRecord();
    repo.insertWorkspaceAuditEvent = async () => {
      throw new Error('audit store unavailable');
    };
    mock.method(logger, 'warn', () => undefined);

    const allowed = await callController(
      createSession,
      createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }, { title: 'Session' })
    );

    assert.equal(allowed.statusCode, 201);
  });

  it('requires create_read_write_runs for explicit read-write messages', async () => {
    installWorkspace('operator');
    repo.getSession = async () => createSessionRecord();
    const denied = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_write' })
    );
    assert.equal(denied.statusCode, 403);

    installWorkspace('admin');
    repo.getSession = async () => createSessionRecord();
    repo.createRunFromUserMessage = async () => ({
      message: createMessage(),
      run: createRun(),
      idempotent: true
    });
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    const allowed = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_write' })
    );
    assert.equal(allowed.statusCode, 202);
  });

  it('requires conversation ownership before creating follow-up runs', async () => {
    installWorkspace('admin');
    repo.getSession = async () => createSessionRecord({ createdBy: 'other-user' });
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: false
      };
    };

    const denied = await callController(
      postMessage,
      createRequest(
        { sessionId: 'session-1' },
        { content: 'diagnose', toolAccessMode: 'read_write', clientMessageId: 'repeat-message' }
      )
    );

    assert.equal(denied.statusCode, 403);
    assert.equal((denied.body as { error: { code: string } }).error.code, 'CONVERSATION_OWNER_REQUIRED');
    assert.equal(attemptedRunCreate, false);
  });

  it('requires cancel_runs to cancel runs', async () => {
    repo.getRun = async () => createRun({ status: 'waiting_for_approval' });
    installWorkspace('viewer');
    const denied = await callController(cancelRun, createRequest({ runId: 'run-1' }));
    assert.equal(denied.statusCode, 403);

    installWorkspace('operator');
    const continuation: RunContinuation = {
      runId: 'run-1',
      approvalId: 'approval-1',
      schemaVersion: 1,
      state: {},
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:00:00.000Z'
    };
    repo.getRunContinuation = async () => continuation;
    repo.expireRunToolApproval = async () => createApproval({ status: 'expired' });
    repo.deleteRunContinuation = async () => true;
    repo.updateRun = async () => createRun({ status: 'cancelled' });
    repo.getLatestRunEventSeq = async () => 0;
    repo.appendRunEvents = async (_runId, events) => events;
    const allowed = await callController(cancelRun, createRequest({ runId: 'run-1' }));
    assert.equal(allowed.statusCode, 202);
  });

  it('requires create_read_write_runs for approval decisions except requester self-rejection', async () => {
    installWorkspace('viewer');
    repo.getRun = async () => createRun();
    repo.getRunToolApproval = async () => createApproval();
    const denied = await callController(
      decideRunApproval,
      createRequest({ runId: 'run-1', approvalId: 'approval-1' }, { decision: 'approved' })
    );
    assert.equal(denied.statusCode, 403);

    let decidedBy = '';
    repo.getRunToolApproval = async () => createApproval({ requestedBy: 'user-1' });
    repo.decideRunToolApproval = async (_approvalId: string, decision: 'approved' | 'rejected', userId: string) => {
      decidedBy = userId;
      return createApproval({ status: 'rejected', decision, requestedBy: 'user-1', decidedBy: userId });
    };
    const allowed = await callController(
      decideRunApproval,
      createRequest({ runId: 'run-1', approvalId: 'approval-1' }, { decision: 'rejected' })
    );
    assert.equal(allowed.statusCode, 200);
    assert.equal(decidedBy, 'user-1');
  });

  it('requires manage_agent_keys to rotate agent keys', async () => {
    installWorkspace('operator');
    const denied = await callController(rotateAgentKey, createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }));
    assert.equal(denied.statusCode, 403);

    installWorkspace('admin');
    const registration: TargetAgentRegistration = {
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      workspaceId: 'workspace-1',
      agentKeyHash: 'old-hash',
      keyVersion: 1
    };
    repo.getTargetAgentRegistration = async () => registration;
    repo.rotateTargetAgentKey = async () => 2;
    let disconnectedClusterId = '';
    mock.method(agentGateway, 'disconnectCluster', async (clusterId: string) => {
      disconnectedClusterId = clusterId;
      return true;
    });
    const allowed = await callController(rotateAgentKey, createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }));
    assert.equal(allowed.statusCode, 200);
    assert.equal(disconnectedClusterId, 'cluster-1');

    repo.rotateTargetAgentKey = async () => null;
    const conflict = await callController(rotateAgentKey, createRequest({ workspaceId: 'workspace-1', clusterId: 'cluster-1' }));
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.body as { error?: { code?: string } }).error?.code, 'AGENT_KEY_ROTATION_CONFLICT');
  });

  it('requires manage_mcp for MCP server mutations', async () => {
    installWorkspace('operator');
    const denied = await callController(
      createTargetMcpServerForTarget,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1' },
        { name: 'server', url: 'https://mcp.example.test', enabled: true }
      )
    );
    assert.equal(denied.statusCode, 403);

    installWorkspace('admin');
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      id: 'server-1',
      workspace_id: 'workspace-1',
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      server_name: 'server',
      server_url: 'https://mcp.example.test',
      enabled: true,
      auth_type: 'none',
      tools: []
    }), { status: 200 }));
    const allowed = await callController(
      createTargetMcpServerForTarget,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1' },
        { name: 'server', url: 'https://mcp.example.test', enabled: true }
      )
    );
    assert.equal(allowed.statusCode, 201);
  });

  it('requires manage_tools for tool settings updates', async () => {
    installWorkspace('operator');
    const denied = await callController(
      updateTargetMcpServerToolSettings,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'server-1', toolName: 'get_pods' }, { enabled: false })
    );
    assert.equal(denied.statusCode, 403);

    installWorkspace('admin');
    repo.setTargetToolOverride = async () => undefined;
    mock.method(globalThis, 'fetch', async (input, init) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({
          name: 'get_pods',
          mcp_server_url: 'builtin://cluster',
          timeout_ms: 10000,
          enabled: false,
          capability: 'read'
        }), { status: 200 });
      }
      if (String(input).includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([{
          id: 'server-1',
          workspace_id: 'workspace-1',
          target_id: 'cluster-1',
          target_type: 'kubernetes',
          server_name: 'builtin',
          server_url: 'builtin://cluster',
          enabled: true,
          auth_type: 'none',
          tools: []
        }]), { status: 200 });
      }
      return new Response(JSON.stringify([
        {
          name: 'get_pods',
          mcp_server_url: 'builtin://cluster',
          timeout_ms: 10000,
          enabled: true,
          capability: 'read'
        }
      ]), { status: 200 });
    });
    const allowed = await callController(
      updateTargetMcpServerToolSettings,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'server-1', toolName: 'get_pods' }, { enabled: false })
    );
    assert.equal(allowed.statusCode, 200);
  });

  it('requires explicit capability when enabling a discovered MCP tool', async () => {
    installWorkspace('admin');
    repo.setTargetToolOverride = async () => undefined;
    mock.method(globalThis, 'fetch', async (input) => {
      if (String(input).includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([{
          id: 'server-1',
          workspace_id: 'workspace-1',
          target_id: 'cluster-1',
          target_type: 'kubernetes',
          server_name: 'external',
          server_url: 'https://mcp.example.test',
          enabled: true,
          auth_type: 'none',
          tools: []
        }]), { status: 200 });
      }
      return new Response(JSON.stringify([
        {
          name: 'external.lookup',
          mcp_server_url: 'https://mcp.example.test',
          timeout_ms: 10000,
          enabled: false,
          capability: 'read',
          source: 'mcp'
        }
      ]), { status: 200 });
    });

    const response = await callController(
      updateTargetMcpServerToolSettings,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'server-1', toolName: 'external.lookup' },
        { enabled: true }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('keeps webhook mutations capability-gated', async () => {
    installWorkspace('operator');
    const denied = await callController(
      createWebhook,
      createRequest(
        { workspaceId: 'workspace-1' },
        { name: 'Webhook', url: 'https://example.test/webhook', eventTypes: ['run.created.v1'], enabled: true }
      )
    );
    assert.equal(denied.statusCode, 403);

    installWorkspace('admin');
    let createInput: Parameters<typeof repo.createWebhookSubscription>[0] | undefined;
    repo.createWebhookSubscription = async (input) => {
      createInput = input;
      return {
        ...createWebhookSubscription(),
        targetId: input.targetId || undefined
      };
    };
    const created = await callController(
      createWebhook,
      createRequest(
        { workspaceId: 'workspace-1' },
        { name: 'Webhook', url: 'https://example.test/webhook', eventTypes: ['run.created.v1'], targetId: 'target-1', enabled: true }
      )
    );
    assert.equal(created.statusCode, 201);
    assert.equal(createInput?.targetId, 'target-1');

    const missingTarget = await callController(
      createWebhook,
      createRequest(
        { workspaceId: 'workspace-1' },
        { name: 'Webhook', url: 'https://example.test/webhook', eventTypes: ['run.created.v1'], targetId: 'missing-target', enabled: true }
      )
    );
    assert.equal(missingTarget.statusCode, 404);
    assert.equal(missingTarget.body.error.message, 'Target not found');

    repo.deleteWebhookSubscription = async () => true;
    const deleted = await callController(deleteWebhook, createRequest({ workspaceId: 'workspace-1', webhookId: 'webhook-1' }));
    assert.equal(deleted.statusCode, 204);
  });
});
