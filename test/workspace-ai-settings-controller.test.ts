import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { postMessage } from '../src/controllers/sessions-controller.js';
import { config } from '../src/config.js';
import {
  deleteWorkspaceAiProviderCredential,
  getWorkspaceAiSettings,
  cleanupWorkspaceAiProviderCredentials,
  updateWorkspaceAiSettings,
  upsertWorkspaceAiProviderCredential
} from '../src/controllers/workspaces/ai-settings-controller.js';
import { repo } from '../src/store/repository.js';
import { postMessageSchema } from '../src/types/contracts.js';
import type { LlmProvider, ReasoningEffort } from '../src/types/domain.js';
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

function installAiCredentialGateway(status: 'configured' | 'missing' | 'disabled' = 'configured') {
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/llm/provider-credentials/') && init?.method === 'PUT') {
      assert.equal(JSON.parse(String(init.body)).api_key, 'test-key');
      return new Response(JSON.stringify({ provider: 'gemini', configured: true, enabled: true }), { status: 200 });
    }
    if (url.includes('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ provider: 'gemini', configured: false, enabled: true }), { status: 200 });
    }
    if (isWorkspaceAiCredentialStatusRequest(input)) {
      const response = createWorkspaceAiCredentialStatusResponse();
      if (status === 'missing') {
        response.providers = response.providers.map((provider) => ({ ...provider, configured: false }));
      }
      if (status === 'disabled') {
        response.providers = response.providers.map((provider) => (
          provider.provider === 'gemini' ? { ...provider, enabled: false } : provider
        ));
      }
      return new Response(JSON.stringify(response), { status: 200 });
    }
    return new Response('unexpected request', { status: 500 });
  });
}

function installFailingAiCredentialGateway() {
  mock.method(globalThis, 'fetch', async (input) => {
    if (isWorkspaceAiCredentialStatusRequest(input)) {
      return new Response(JSON.stringify({ detail: 'gateway unavailable' }), { status: 503 });
    }
    return new Response('unexpected request', { status: 500 });
  });
}

describe('workspace AI settings controller', () => {
  it('leaves semantic llm validation to the session controller after request body validation', () => {
    const parsed = postMessageSchema.safeParse({
      content: 'diagnose',
      toolAccessMode: 'read_write',
      llm: { reasoningEffort: 'extra_high' }
    });

    assert.equal(parsed.success, true);
    if (!parsed.success) assert.fail('expected malformed llm selection to pass body shape validation');
    assert.deepEqual(parsed.data.llm, { reasoningEffort: 'extra_high' });
    assert.equal(postMessageSchema.safeParse({ content: '' }).success, false);
  });

  it('returns safe workspace AI settings without credential values or secret names', async () => {
    installWorkspace('viewer');
    installAiCredentialGateway();

    const response = await callController(
      getWorkspaceAiSettings,
      createRequest({ workspaceId: 'workspace-1' })
    );

    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.defaultProvider, 'openai');
    assert.equal(body.reasoningSummaryMode, 'auto');
    assert.equal(body.reasoningSummariesEnabled, true);
    assert.deepEqual(body.allowedProviders, ['openai', 'anthropic', 'gemini']);
    assert.deepEqual(Object.keys(body.allowedProviderModels as Record<string, unknown>), ['openai', 'anthropic', 'gemini']);
    assert((body.allowedProviderModels as Record<string, string[]>).openai.includes('gpt-5.5'));
    assert((body.allowedProviderModels as Record<string, string[]>).anthropic.includes('claude-sonnet-4-6'));
    assert((body.allowedProviderModels as Record<string, string[]>).gemini.includes('gemini-2.5-flash'));
    assert(Array.isArray(body.providers));
    assert(!JSON.stringify(body).includes('apiKey'));
    assert(!JSON.stringify(body).includes('secret'));
  });

  it('allows workspace readers without operational data access to view safe AI settings status', async () => {
    installWorkspace('auditor');
    installAiCredentialGateway();

    const response = await callController(
      getWorkspaceAiSettings,
      createRequest({ workspaceId: 'workspace-1' })
    );

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { defaultProvider: string }).defaultProvider, 'openai');
  });

  it('reports providers as disabled when the gateway adapter is disabled', async () => {
    installWorkspace('viewer');
    installAiCredentialGateway('disabled');

    const response = await callController(
      getWorkspaceAiSettings,
      createRequest({ workspaceId: 'workspace-1' })
    );

    assert.equal(response.statusCode, 200);
    const body = response.body as { allowedProviders: string[]; providers: Array<{ provider: string; enabled: boolean }> };
    assert(!body.allowedProviders.includes('gemini'));
    assert.equal(body.providers.find((provider) => provider.provider === 'gemini')?.enabled, false);
  });

  it('rejects default updates to providers disabled by the gateway', async () => {
    installWorkspace('admin');
    installAiCredentialGateway('disabled');
    let attemptedPersist = false;
    repo.upsertWorkspaceAiSettings = async () => {
      attemptedPersist = true;
    };

    const response = await callController(
      updateWorkspaceAiSettings,
      createRequest(
        { workspaceId: 'workspace-1' },
        { defaultProvider: 'gemini', defaultModel: 'gemini-2.0-flash' }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'PROVIDER_NOT_ALLOWED');
    assert.equal(attemptedPersist, false);
  });

  it('rejects credential saves for providers disabled by the gateway', async () => {
    installWorkspace('admin');
    installAiCredentialGateway('disabled');

    const response = await callController(
      upsertWorkspaceAiProviderCredential,
      createRequest({ workspaceId: 'workspace-1', provider: 'gemini' }, { apiKey: 'test-key' })
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'PROVIDER_NOT_ALLOWED');
  });

  it('allows credential deletes for providers disallowed by deployment policy so stale secrets can be cleaned up', async () => {
    installWorkspace('admin');
    let deleted = false;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
        deleted = true;
        return new Response(JSON.stringify({ provider: 'gemini', configured: false, enabled: true }), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        const response = createWorkspaceAiCredentialStatusResponse();
        response.providers = response.providers.map((provider) => (
          provider.provider === 'gemini' ? { ...provider, configured: !deleted } : provider
        ));
        return new Response(JSON.stringify(response), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    const previousAllowedProviders = config.LLM_ALLOWED_PROVIDERS;
    config.LLM_ALLOWED_PROVIDERS = 'openai,anthropic';

    try {
      const response = await callController(
        deleteWorkspaceAiProviderCredential,
        createRequest({ workspaceId: 'workspace-1', provider: 'gemini' })
      );

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { providers: Array<{ provider: string; configured: boolean }> }).providers.find((provider) => provider.provider === 'gemini')?.configured, false);
    } finally {
      config.LLM_ALLOWED_PROVIDERS = previousAllowedProviders;
    }
  });

  it('uses AI-specific copy when provider credential status cannot be synchronized', async () => {
    installWorkspace('viewer');
    installFailingAiCredentialGateway();

    const response = await callController(
      getWorkspaceAiSettings,
      createRequest({ workspaceId: 'workspace-1' })
    );

    assert.equal(response.statusCode, 502);
    assert.equal(
      (response.body as { error: { message: string } }).error.message,
      'Failed to synchronize AI provider settings with llm-gateway'
    );
  });

  it('requires manage_ai_settings for default provider and credential mutations', async () => {
    installWorkspace('operator');
    installAiCredentialGateway();

    const defaults = await callController(
      updateWorkspaceAiSettings,
      createRequest(
        { workspaceId: 'workspace-1' },
        { defaultProvider: 'openai', defaultModel: 'gpt-5.5' }
      )
    );
    const credential = await callController(
      upsertWorkspaceAiProviderCredential,
      createRequest({ workspaceId: 'workspace-1', provider: 'gemini' }, { apiKey: 'test-key' })
    );

    assert.equal(defaults.statusCode, 403);
    assert.equal(credential.statusCode, 403);
  });

  it('saves and deletes provider credentials through the gateway without exposing the key', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    const auditEvents: string[] = [];
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditEvents.push(event.eventType);
      return {
        id: 'audit-event-1',
        workspaceId: event.workspaceId,
        category: event.category,
        eventType: event.eventType,
        actor: { type: 'user', userId: event.actorUserId },
        object: { type: event.objectType, id: event.objectId },
        summary: event.summary,
        metadata: event.metadata ?? {},
        occurredAt: '2026-05-24T00:00:00.000Z'
      };
    };

    const saved = await callController(
      upsertWorkspaceAiProviderCredential,
      createRequest({ workspaceId: 'workspace-1', provider: 'gemini' }, { apiKey: 'test-key' })
    );
    const deleted = await callController(
      deleteWorkspaceAiProviderCredential,
      createRequest({ workspaceId: 'workspace-1', provider: 'gemini' })
    );

    assert.equal(saved.statusCode, 200);
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(auditEvents, [
      'workspace.ai_provider_credential.saved.v1',
      'workspace.ai_provider_credential.deleted.v1'
    ]);
    assert(!JSON.stringify(saved.body).includes('test-key'));
    assert(!JSON.stringify(deleted.body).includes('test-key'));
  });

  it('cleans up every workspace provider credential when deleting a workspace', async () => {
    const deletedProviders: string[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
        deletedProviders.push(decodeURIComponent(url.pathname.split('/').at(-1) || ''));
        assert.equal(url.searchParams.get('workspace_id'), 'workspace-1');
        return new Response(JSON.stringify({ provider: deletedProviders.at(-1), configured: false, enabled: true }), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    await cleanupWorkspaceAiProviderCredentials('workspace-1');

    assert.deepEqual(deletedProviders, ['openai', 'anthropic', 'gemini']);
  });

  it('rejects run creation before dispatch when the selected provider credential is missing', async () => {
    installWorkspace('admin');
    installAiCredentialGateway('missing');
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_write' })
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'AI_PROVIDER_CREDENTIAL_MISSING');
    assert.equal(attemptedRunCreate, false);
  });

  it('keeps accepted client message retries idempotent even if credentials are later missing', async () => {
    installWorkspace('admin');
    installAiCredentialGateway('missing');
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => ({
      message: createMessage({ id: 'existing-message', clientMessageId: 'retry-message', runId: 'existing-run' }),
      run: createRun({ id: 'existing-run' }),
      idempotent: true
    });
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: false
      };
    };

    const response = await callController(
      postMessage,
      createRequest(
        { sessionId: 'session-1' },
        { content: 'diagnose', toolAccessMode: 'read_write', clientMessageId: 'retry-message' }
      )
    );

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.body, { message_id: 'existing-message', run_id: 'existing-run' });
    assert.equal(attemptedRunCreate, false);
  });

  it('freezes the selected provider and model on newly created runs', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5'
    });
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let createdRunInput: { llmProvider?: LlmProvider; llmModel?: string } | undefined;
    repo.createRunFromUserMessage = async (input) => {
      createdRunInput = input;
      return {
        message: createMessage(),
        run: createRun({ llmProvider: input.llmProvider, llmModel: input.llmModel }),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_write' })
    );

    assert.equal(response.statusCode, 202);
    assert.equal(createdRunInput?.llmProvider, 'openai');
    assert.equal(createdRunInput?.llmModel, 'gpt-5.5');
  });

  it('freezes per-message provider, model, and reasoning effort overrides on newly created runs', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'auto',
      reasoningEffort: 'off'
    });
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let createdRunInput: {
      llmProvider?: LlmProvider;
      llmModel?: string;
      llmReasoningEffort?: ReasoningEffort;
    } | undefined;
    repo.createRunFromUserMessage = async (input) => {
      createdRunInput = input;
      return {
        message: createMessage(),
        run: createRun({
          llmProvider: input.llmProvider,
          llmModel: input.llmModel,
          llmReasoningEffort: input.llmReasoningEffort
        }),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest(
        { sessionId: 'session-1' },
        {
          content: 'diagnose',
          toolAccessMode: 'read_write',
          llm: {
            provider: 'gemini',
            model: 'gemini-2.0-flash',
            reasoningEffort: 'high'
          }
        }
      )
    );

    assert.equal(response.statusCode, 202);
    assert.equal(createdRunInput?.llmProvider, 'gemini');
    assert.equal(createdRunInput?.llmModel, 'gemini-2.0-flash');
    assert.equal(createdRunInput?.llmReasoningEffort, 'high');
  });

  it('rejects per-message model overrides that omit provider', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest(
        { sessionId: 'session-1' },
        { content: 'diagnose', toolAccessMode: 'read_write', llm: { model: 'gpt-5.5' } }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'INVALID_LLM_SELECTION');
    assert.equal(attemptedRunCreate, false);
  });

  it('rejects per-message provider overrides that omit model', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest(
        { sessionId: 'session-1' },
        { content: 'diagnose', toolAccessMode: 'read_write', llm: { provider: 'gemini' } }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'INVALID_LLM_SELECTION');
    assert.equal(attemptedRunCreate, false);
  });

  it('rejects per-message reasoning effort overrides that deployment policy does not allow', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest(
        { sessionId: 'session-1' },
        { content: 'diagnose', toolAccessMode: 'read_write', llm: { reasoningEffort: 'extra_high' } }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'REASONING_EFFORT_NOT_ALLOWED');
    assert.equal(attemptedRunCreate, false);
  });

  it('rejects per-message reasoning effort overrides excluded by deployment policy', async () => {
    const previousAllowedEfforts = config.LLM_ALLOWED_REASONING_EFFORTS;
    config.LLM_ALLOWED_REASONING_EFFORTS = 'low';
    try {
      installWorkspace('admin');
      installAiCredentialGateway();
      repo.getSession = async () => createSessionRecord();
      repo.findRunByClientMessageId = async () => null;
      let attemptedRunCreate = false;
      repo.createRunFromUserMessage = async () => {
        attemptedRunCreate = true;
        return {
          message: createMessage(),
          run: createRun(),
          idempotent: true
        };
      };

      const response = await callController(
        postMessage,
        createRequest(
          { sessionId: 'session-1' },
          { content: 'diagnose', toolAccessMode: 'read_write', llm: { reasoningEffort: 'high' } }
        )
      );

      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'REASONING_EFFORT_NOT_ALLOWED');
      assert.equal(attemptedRunCreate, false);
    } finally {
      config.LLM_ALLOWED_REASONING_EFFORTS = previousAllowedEfforts;
    }
  });

  it('keeps accepted client message retries idempotent even if the llm override is malformed', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => ({
      message: createMessage({ id: 'existing-message', clientMessageId: 'retry-message', runId: 'existing-run' }),
      run: createRun({ id: 'existing-run' }),
      idempotent: true
    });
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: false
      };
    };

    const response = await callController(
      postMessage,
      createRequest(
        { sessionId: 'session-1' },
        { content: 'diagnose', toolAccessMode: 'read_write', clientMessageId: 'retry-message', llm: { model: 'gpt-5.5' } }
      )
    );

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.body, { message_id: 'existing-message', run_id: 'existing-run' });
    assert.equal(attemptedRunCreate, false);
  });

  it('rejects run creation before dispatch when the selected provider is disabled', async () => {
    installWorkspace('admin');
    installAiCredentialGateway('disabled');
    repo.getWorkspaceAiSettings = async () => ({ workspaceId: 'workspace-1', defaultProvider: 'gemini', defaultModel: 'gemini-2.0-flash' });
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_write' })
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'PROVIDER_NOT_ALLOWED');
    assert.equal(attemptedRunCreate, false);
  });

  it('persists allowed default provider and model changes', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    let persisted: Parameters<typeof repo.upsertWorkspaceAiSettings>[1] | undefined;
    repo.upsertWorkspaceAiSettings = async (_workspaceId, settings) => {
      persisted = settings;
    };

    const response = await callController(
      updateWorkspaceAiSettings,
      createRequest(
        { workspaceId: 'workspace-1' },
        { defaultProvider: 'openai', defaultModel: 'gpt-5.5' }
      )
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(persisted, { defaultProvider: 'openai', defaultModel: 'gpt-5.5', reasoningSummaryMode: 'auto', reasoningEffort: 'low' });
  });

  it('rejects default model changes that do not match the selected provider', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();

    const response = await callController(
      updateWorkspaceAiSettings,
      createRequest(
        { workspaceId: 'workspace-1' },
        { defaultProvider: 'openai', defaultModel: 'gemini-2.0-flash' }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MODEL_NOT_ALLOWED');
  });

  it('rejects run creation before dispatch when stored provider and model do not match', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gemini-2.0-flash'
    });
    repo.getSession = async () => createSessionRecord();
    repo.findRunByClientMessageId = async () => null;
    let attemptedRunCreate = false;
    repo.createRunFromUserMessage = async () => {
      attemptedRunCreate = true;
      return {
        message: createMessage(),
        run: createRun(),
        idempotent: true
      };
    };

    const response = await callController(
      postMessage,
      createRequest({ sessionId: 'session-1' }, { content: 'diagnose', toolAccessMode: 'read_write' })
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MODEL_NOT_ALLOWED');
    assert.equal(attemptedRunCreate, false);
  });
});
