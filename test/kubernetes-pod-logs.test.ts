import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { agentGateway } from '../src/agent/ws-server.js';
import { getPodLogs } from '../src/controllers/workspaces/kubernetes-cluster-controller.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import type { KubernetesCluster } from '../src/types/domain.js';

const cluster: KubernetesCluster = {
  id: 'cluster-1', workspaceId: 'workspace-1', name: 'cluster-1', status: 'online',
  namespaceInclude: [], namespaceExclude: [], permissionMode: 'auto_allowed_changes',
  permissionModeOverride: null, permissionModeSource: 'deployment_default',
  writeConfirmationRequiredOverride: null,
  writeConfirmationPolicy: { effectiveRequired: false, overrideRequired: null, source: 'deployment_default' },
  createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z'
};

function agentResult(data: Record<string, unknown>, isError = true) {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      schemaVersion: 'acornops.model-context.v1', tool: 'get_resource_logs',
      status: isError ? 'error' : 'success', summary: 'Pod log result', data, omissions: []
    }) }],
    structuredContent: { schemaVersion: 'acornops.full-tool-result.v1', data },
    isError
  };
}

async function readLogs() {
  const req = {
    auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
    params: { workspaceId: 'workspace-1', clusterId: 'cluster-1', namespace: 'default', podName: 'api-pod' },
    query: { container: 'api' }
  };
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }
  };
  await getPodLogs(req as never, res as never, (err?: unknown) => { if (err) throw err; });
  return res;
}

describe('console pod log requests', () => {
  beforeEach(() => {
    mock.method(repo, 'getWorkspaceRole', async () => 'admin');
    mock.method(repo, 'getCluster', async () => cluster);
    mock.method(repo, 'insertWorkspaceAuditEvent', async () => undefined);
    mock.method(webhooks, 'emit', () => undefined);
  });
  afterEach(() => { mock.restoreAll(); });

  it('preserves a container-not-started error through MCP unwrapping without leaking upstream details', async () => {
    mock.method(agentGateway, 'callAgentMcpTool', async () => agentResult({
      code: 'PRECONDITION_FAILED', status: 400, reason: 'ContainerNotStarted',
      phase: 'kubernetes_api', message: 'upstream private-registry/image details', retryable: false
    }));

    const res = await readLogs();

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: {
      code: 'POD_LOGS_UNAVAILABLE', message: 'No logs yet; this container has not started.', retryable: false
    } });
    const webhook = (webhooks.emit as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls[0].arguments[0];
    assert.doesNotMatch(JSON.stringify(webhook), /private-registry/);
  });

  for (const data of [
    { code: 'PRECONDITION_FAILED', reason: 'KubernetesPreconditionFailed', status: 400 },
    { code: 'KUBERNETES_FORBIDDEN', reason: 'ContainerNotStarted', status: 403 },
    { code: 'PRECONDITION_FAILED', reason: 'ContainerNotStarted', status: 403 }
  ]) {
    it(`keeps unrelated ${data.code}/${data.reason}/${data.status} failures as agent errors`, async () => {
      mock.method(agentGateway, 'callAgentMcpTool', async () => agentResult({ ...data, message: 'Tool failed', retryable: false }));

      const res = await readLogs();

      assert.equal(res.statusCode, 502);
      assert.deepEqual(res.body, { error: { code: 'AGENT_TOOL_ERROR', message: 'Tool failed', retryable: false } });
    });
  }

  it('still returns log content for a started container', async () => {
    mock.method(agentGateway, 'callAgentMcpTool', async () => agentResult({
      name: 'api-pod', namespace: 'default', container: 'api', logs: 'ready\n'
    }, false));

    const res = await readLogs();

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { logs: string }).logs, 'ready\n');
  });

  it('keeps disconnected agents retryable', async () => {
    mock.method(agentGateway, 'callAgentMcpTool', async () => { throw new Error('Agent not connected'); });

    const res = await readLogs();

    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: { code: 'AGENT_UNAVAILABLE', message: 'Agent not connected', retryable: true } });
  });
});
