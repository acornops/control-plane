import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
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
import {
  callController,
  createRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  installAiCredentialGateway,
  installFailingAiCredentialGateway
} from './helpers/workspace-ai-settings-fixtures.js';

afterEach(restoreControllerRegressionState);

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

  it('accepts bounded unique structured tool and skill references', () => {
    const parsed = postMessageSchema.safeParse({
      content: 'diagnose',
      references: [
        { kind: 'tool', id: 'mcp__postgres__inspect_cluster' },
        { kind: 'skill', id: 'd5bd1f0a-9718-47f8-833b-bdd8a71fda20' }
      ]
    });
    assert.equal(parsed.success, true);
    assert.equal(postMessageSchema.safeParse({
      content: 'diagnose',
      references: [{ kind: 'tool', id: 'same' }, { kind: 'tool', id: 'same' }]
    }).success, false);
    assert.equal(postMessageSchema.safeParse({
      content: 'diagnose',
      references: Array.from({ length: 9 }, (_, index) => ({ kind: 'tool', id: `tool_${index}` }))
    }).success, false);
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
    assert.equal(body.reasoningEffort, 'low');
    assert.deepEqual(body.allowedReasoningEfforts, ['off', 'low', 'medium', 'high']);
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

    assert.equal(response.statusCode, 503);
    assert.equal((response.body as { error: { code: string } }).error.code, 'SERVICE_UNAVAILABLE');
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
    let requeued = 0;
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
    repo.requeueTargetInsightsPausedCheckpoints = async (workspaceId, targetId) => {
      assert.equal(workspaceId, 'workspace-1');
      assert.equal(targetId, undefined);
      requeued += 1;
      return 2;
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
    assert.equal(requeued, 1);
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

  it('persists allowed default provider and model changes', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    let persisted: Parameters<typeof repo.upsertWorkspaceAiSettings>[1] | undefined;
    let requeued = 0;
    repo.upsertWorkspaceAiSettings = async (_workspaceId, settings) => {
      persisted = settings;
    };
    repo.requeueTargetInsightsPausedCheckpoints = async (workspaceId, targetId) => {
      assert.equal(workspaceId, 'workspace-1');
      assert.equal(targetId, undefined);
      requeued += 1;
      return 1;
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
    assert.equal(requeued, 1);
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

});
