import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  putMcpConnection,
  verifyMcpConnectionStatus
} from '../src/controllers/mcp-connections-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

function individualServer() {
  return {
    id: 'server-agent-1',
    workspace_id: 'workspace-1',
    scope_type: 'agent',
    agent_id: 'agent-1',
    server_name: 'Operations',
    server_url: 'https://mcp.example/mcp',
    enabled: true,
    auth_type: 'custom_header',
    credential_mode: 'individual',
    tools: []
  };
}

function workspaceServer() {
  return { ...individualServer(), credential_mode: 'workspace' as const };
}

describe('MCP credential connection controllers', () => {
  it('denies a viewer without a run capability before mutating an Agent connection', async () => {
    installWorkspace('viewer');
    const gateway = mock.method(globalThis, 'fetch', async () => (
      new Response(JSON.stringify([individualServer()]), { status: 200 })
    ));

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'pat', consentGranted: true }
    ));

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
    assert.equal(gateway.mock.callCount(), 1);
  });

  it('denies a viewer without a run capability before mutating a target connection', async () => {
    installWorkspace('viewer');
    const gateway = mock.method(globalThis, 'fetch', async () => (
      new Response(JSON.stringify([{ ...individualServer(), id: 'server-target-1', scope_type: 'target', agent_id: null, target_id: 'target-1' }]), { status: 200 })
    ));

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', targetId: 'target-1', serverId: 'server-target-1' },
      { credential: 'pat', consentGranted: true }
    ));

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
    assert.equal(gateway.mock.callCount(), 1);
  });

  it('allows an operator to manage only their own individual credential and redacts audit metadata', async () => {
    installWorkspace('operator');
    const bodies: Array<Record<string, unknown>> = [];
    const audits: unknown[] = [];
    repo.insertWorkspaceAuditEvent = async (event) => {
      audits.push(event);
      return {
        id: 'audit-1',
        workspaceId: event.workspaceId,
        category: event.category,
        eventType: event.eventType,
        actor: { type: 'user', userId: event.actorUserId },
        object: { type: event.objectType, id: event.objectId },
        summary: event.summary,
        metadata: event.metadata ?? {},
        occurredAt: '2026-07-16T00:00:00.000Z'
      };
    };
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'GET') {
        return new Response(JSON.stringify([individualServer()]), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        server_id: 'server-agent-1',
        credential_mode: 'individual',
        status: 'connected',
        auth_type: 'custom_header',
        action: null
      }), { status: 200 });
    });

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'top-secret-pat', consentGranted: true }
    ));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(bodies, [{
      workspace_id: 'workspace-1',
      owner_type: 'user',
      owner_id: 'user-1',
      credential: 'top-secret-pat',
      consent_granted: true
    }]);
    assert.equal(JSON.stringify(audits).includes('top-secret-pat'), false);
    assert.deepEqual(response.body, { connection: {
      serverId: 'server-agent-1',
      credentialMode: 'individual',
      status: 'connected',
      managementScope: 'individual',
      canManage: true,
      authType: 'custom_header',
      action: undefined
    } });
  });

  it('requires manage_mcp for workspace credential mutations', async () => {
    installWorkspace('operator');
    const gateway = mock.method(globalThis, 'fetch', async () => (
      new Response(JSON.stringify([workspaceServer()]), { status: 200 })
    ));

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'service-token', consentGranted: true }
    ));

    assert.equal(response.statusCode, 403);
    assert.equal(gateway.mock.callCount(), 1);
  });

  it('uses the canonical installation owner for workspace credentials', async () => {
    installWorkspace('admin');
    const bodies: Array<Record<string, unknown>> = [];
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify([workspaceServer()]), { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        server_id: 'server-agent-1', credential_mode: 'workspace', status: 'connected', auth_type: 'custom_header'
      }), { status: 200 });
    });

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'service-token', consentGranted: true }
    ));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(bodies, [{
      workspace_id: 'workspace-1', owner_type: 'installation', owner_id: 'installation',
      credential: 'service-token', consent_granted: true
    }]);
    assert.deepEqual((response.body as { connection: Record<string, unknown> }).connection, {
      serverId: 'server-agent-1', credentialMode: 'workspace', status: 'connected',
      managementScope: 'workspace', canManage: true, authType: 'custom_header', action: undefined
    });
  });

  it('denies auditors who cannot read the destination', async () => {
    installWorkspace('auditor');
    const gateway = mock.method(globalThis, 'fetch', async () => {
      throw new Error('gateway must not be called');
    });

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'pat', consentGranted: true }
    ));

    assert.equal(response.statusCode, 403);
    assert.equal(gateway.mock.callCount(), 0);
  });

  it('rejects removed OAuth-style fields instead of silently accepting them', async () => {
    installWorkspace('admin');
    const gateway = mock.method(globalThis, 'fetch', async () => (
      new Response(JSON.stringify([individualServer()]), { status: 200 })
    ));

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'pat', consentGranted: true, scopes: ['tools.read'] }
    ));

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MCP_CONNECTION_INVALID');
    assert.equal(gateway.mock.callCount(), 1);
  });

  it('rejects attempts to select another user', async () => {
    installWorkspace('operator');
    mock.method(globalThis, 'fetch', async () => (
      new Response(JSON.stringify([individualServer()]), { status: 200 })
    ));

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'pat', consentGranted: true, userId: 'user-2' }
    ));

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MCP_CONNECTION_INVALID');
  });

  it('enforces the UTF-8 byte limit and rejects control characters without trimming', async () => {
    installWorkspace('operator');
    const forwarded: string[] = [];
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify([individualServer()]), { status: 200 });
      forwarded.push((JSON.parse(String(init?.body)) as { credential: string }).credential);
      return new Response(JSON.stringify({
        server_id: 'server-agent-1',
        credential_mode: 'individual',
        status: 'connected',
        auth_type: 'custom_header'
      }), { status: 200 });
    });

    const exact = ` ${'x'.repeat(8190)} `;
    const accepted = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: exact, consentGranted: true }
    ));
    const oversized = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'é'.repeat(4097), consentGranted: true }
    ));
    const controlled = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'pat\u0000value', consentGranted: true }
    ));

    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(forwarded, [exact]);
    assert.equal(oversized.statusCode, 400);
    assert.equal(controlled.statusCode, 400);
  });

  it('forwards the gateway Retry-After header for throttled connection mutations', async () => {
    installWorkspace('operator');
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify([individualServer()]), { status: 200 });
      return new Response(JSON.stringify({ detail: 'rate limited' }), {
        status: 429,
        headers: { 'Retry-After': '17' }
      });
    });

    const response = await callController(putMcpConnection, createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      { credential: 'pat', consentGranted: true }
    ));

    assert.equal(response.statusCode, 429);
    assert.equal(response.headers.get('retry-after'), '17');
  });

  it('retries the stored credential through the installation-scoped verify endpoint', async () => {
    installWorkspace('admin');
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (init?.method === 'GET') {
        return new Response(JSON.stringify([individualServer()]), { status: 200 });
      }
      return new Response(JSON.stringify({
        server_id: 'server-agent-1',
        credential_mode: 'individual',
        status: 'error',
        auth_type: 'custom_header',
        action: 'verify_mcp_server'
      }), { status: 200 });
    });

    const response = await callController(verifyMcpConnectionStatus, createRequest({
      workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1'
    }));

    assert.equal(response.statusCode, 200);
    assert.match(requests[1].url, /connections\/user-1\/verify$/);
    assert.deepEqual(requests[1].body, { workspace_id: 'workspace-1', owner_type: 'user', owner_id: 'user-1' });
    assert.equal(JSON.stringify(requests[1]).includes('credential'), false);
  });
});
