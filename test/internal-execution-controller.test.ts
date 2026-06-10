import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { bootstrap, commitRun, ingestRunEvents, normalizeToolCapability } from '../src/controllers/internal-execution-controller.js';
import { repo } from '../src/store/repository.js';
import { runtime } from '../src/store/runtime.js';
import type { RunEvent } from '../src/types/domain.js';
import {
  callController,
  createMessage,
  createRequest,
  createRun,
  createSessionRecord,
  createTarget,
  createWorkspaceAiCredentialStatusResponse,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const originalAppendRunEvents = repo.appendRunEvents;
const originalUpdateRun = repo.updateRun;
const originalUpsertAssistantFinalMessage = repo.upsertAssistantFinalMessage;

afterEach(() => {
  restoreControllerRegressionState();
  repo.appendRunEvents = originalAppendRunEvents;
  repo.updateRun = originalUpdateRun;
  repo.upsertAssistantFinalMessage = originalUpsertAssistantFinalMessage;
  runtime.clearRunEvents('run-1');
});

function createRunEvent(type: string, seq: number, payload: Record<string, unknown> = {}): RunEvent {
  return {
    schema_version: 1,
    run_id: 'run-1',
    seq,
    ts: '2026-05-24T00:00:00.000Z',
    type,
    payload
  };
}

describe('internal execution bootstrap audit metadata', () => {
  it('defaults unknown tool capabilities to write for audit classification', () => {
    assert.equal(normalizeToolCapability({ capability: 'read' }), 'read');
    assert.equal(normalizeToolCapability({ capability: 'write' }), 'write');
    assert.equal(normalizeToolCapability({ capability: undefined }), 'write');
    assert.equal(normalizeToolCapability({ capability: 'unknown' as never }), 'write');
  });

  it('allows VM write tools when the target advertises write capability and the run is read-write', async () => {
    repo.getRun = async () => createRun({ targetId: 'vm-1', targetType: 'virtual_machine', toolAccessMode: 'read_write' });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => ({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      workspaceId: 'workspace-1',
      agentKeyHash: 'hash',
      keyVersion: 1,
      capabilities: ['read', 'write']
    });
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([
          {
            name: 'restart_service',
            mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
            timeout_ms: 10000,
            description: 'Restart a VM service',
            capability: 'write',
            version: 'v1',
            source: 'builtin',
            input_schema: { type: 'object' },
            enabled: true
          },
          {
            name: 'get_logs',
            mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
            timeout_ms: 10000,
            description: 'Read VM logs',
            capability: 'read',
            version: 'v1',
            source: 'builtin',
            input_schema: { type: 'object' },
            enabled: true
          }
        ]), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const allowedTools = (response.body as { tools: { allowed_tools: string[] } }).tools.allowed_tools;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(allowedTools, ['get_logs', 'restart_service']);
  });

  it('bootstraps with the run provider/model snapshot even when workspace defaults changed later', async () => {
    repo.getRun = async () => createRun({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      clusterId: undefined,
      llmProvider: 'openai',
      llmModel: 'gpt-4.1-mini'
    });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => null;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'gemini',
      defaultModel: 'gemini-2.0-flash'
    });
    repo.listTargetToolOverrides = async () => ({});
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const llm = (response.body as { llm: { provider: string; model: string } }).llm;

    assert.equal(response.statusCode, 200);
    assert.equal(llm.provider, 'openai');
    assert.equal(llm.model, 'gpt-4.1-mini');
  });

  it('maps workspace AI credential status failures during bootstrap', async () => {
    repo.getRun = async () => createRun({ status: 'queued' });
    repo.getTarget = async () => createTarget();
    repo.getSession = async () => createSessionRecord();
    repo.getTargetAgentRegistration = async () => null;
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify({ detail: 'llm-gateway unavailable' }), { status: 503 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to check workspace AI provider settings with llm-gateway',
        retryable: true
      }
    });
  });

  it('drops late execution events for runs that are already cancelled', async () => {
    let appended = false;
    repo.getRun = async () => createRun({ status: 'cancelled' });
    repo.appendRunEvents = async () => {
      appended = true;
      return [];
    };

    const response = await callController(ingestRunEvents, createRequest({ runId: 'run-1' }, {
      events: [
        createRunEvent('assistant_token_delta', 10, { text: 'stale' }),
        createRunEvent('run_completed', 11)
      ]
    }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'ok', accepted: 0 });
    assert.equal(appended, false);
  });

  it('accepts only run_cancelled while a run is cancelling', async () => {
    let appendedEvents: RunEvent[] = [];
    repo.getRun = async () => createRun({ status: 'cancelling' });
    repo.appendRunEvents = async (_runId, events) => {
      appendedEvents = events;
      return events;
    };
    repo.updateRun = async () => createRun({ status: 'cancelled' });

    const response = await callController(ingestRunEvents, createRequest({ runId: 'run-1' }, {
      events: [
        createRunEvent('run_progress', 1, { stage: 'reasoning' }),
        createRunEvent('run_cancelled', 2, { reason: 'user_cancelled' }),
        createRunEvent('assistant_token_delta', 3, { text: 'stale' })
      ]
    }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'ok', accepted: 1 });
    assert.deepEqual(appendedEvents.map((event) => event.type), ['run_cancelled']);
  });

  it('does not mutate cancelled runs when a late terminal commit arrives', async () => {
    let updated = false;
    let upserted = false;
    repo.getRun = async () => createRun({ status: 'cancelled' });
    repo.updateRun = async () => {
      updated = true;
      return createRun({ status: 'completed' });
    };
    repo.upsertAssistantFinalMessage = async () => {
      upserted = true;
      return createMessage();
    };

    const response = await callController(commitRun, createRequest({ runId: 'run-1' }, {
      status: 'completed',
      assistant_message: { content: 'stale answer', format: 'markdown' },
      usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0 },
      timing: {
        started_at: '2026-05-24T00:00:00.000Z',
        ended_at: '2026-05-24T00:00:01.000Z'
      }
    }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'ok', terminal: true });
    assert.equal(updated, false);
    assert.equal(upserted, false);
  });

  it('does not persist assistant content from cancelled execution commits', async () => {
    let assistantMessageContent: string | undefined;
    let upsertedContent: string | undefined;
    repo.getRun = async () => createRun({ status: 'running' });
    repo.updateRun = async (_runId, update) => {
      assistantMessageContent = String(update.assistantMessage?.content || '');
      return createRun({ status: 'cancelled', assistantMessage: update.assistantMessage });
    };
    repo.upsertAssistantFinalMessage = async (_sessionId, _runId, content) => {
      upsertedContent = content;
      return { ...createMessage(), role: 'assistant', kind: 'assistant', content };
    };

    const response = await callController(commitRun, createRequest({ runId: 'run-1' }, {
      status: 'cancelled',
      assistant_message: { content: 'stale partial answer', format: 'markdown' },
      usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0 },
      timing: {
        started_at: '2026-05-24T00:00:00.000Z',
        ended_at: '2026-05-24T00:00:01.000Z'
      }
    }));

    assert.equal(response.statusCode, 200);
    assert.equal(assistantMessageContent, '');
    assert.equal(upsertedContent, 'I could not complete the troubleshooting run.\n\nThe run was cancelled.');
  });
});
