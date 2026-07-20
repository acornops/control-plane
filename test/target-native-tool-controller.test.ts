import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { listTargetTools, updateTargetToolSettings } from '../src/controllers/workspaces/target-native-tool-controller.js';
import { listWorkspaceNativeToolsForInvocationScope } from '../src/services/workspace-native-tools.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target native tool controller', () => {
  it('lists default built-in target tools when the target has no explicit setting', async () => {
    installWorkspace('operator');
    repo.getTargetToolSetting = async () => null;
    const gatewayFetch = mock.method(globalThis, 'fetch', async () => {
      throw new Error('tools catalog must not call the llm gateway');
    });

    const response = await callController(
      listTargetTools,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' })
    );

    const body = response.body as { items: Array<{ id: string; enabled: boolean; config: Record<string, unknown> }> };
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.items, [
      {
        id: 'web_search',
        label: 'Web Search',
        enabled: true,
        description: 'Allow assistant runs for this target to search the web through the selected LLM provider.',
        origin: 'target_setting',
        capability: 'read',
        runtimeKind: 'provider_native',
        visibility: {
          appearsInAssistantToolList: true,
          appearsInRunEnabledTools: true,
          appearsInToolCalls: false
        },
        config: {
          domainFilters: {
            allowedDomains: [],
            blockedDomains: []
          }
        },
        permissions: {
          canEdit: false
        }
      },
      {
        id: 'target_insights',
        label: 'Insights',
        enabled: true,
        description: 'Retrieve and improve target-specific troubleshooting insights for future assistant runs.',
        origin: 'target_setting',
        capability: 'read',
        runtimeKind: 'function',
        visibility: {
          appearsInAssistantToolList: true,
          appearsInRunEnabledTools: true,
          appearsInToolCalls: false
        },
        config: {
          learning: {
            idleCheckpointDelayMinutes: 30,
            minimumObservationsBeforeGeneralization: 3,
            checkpointModel: {
              mode: 'workspace_default'
            }
          },
          retrieval: {
            maxSnippetsPerRetrieval: 4,
            maxSnippetSizeBytes: 1536
          }
        },
        readiness: {
          learningAvailable: true,
          learningPausedReason: null
        },
        permissions: {
          canEdit: false
        }
      },
      {
        id: 'reports.pdf.generate',
        label: 'Generate PDF report',
        enabled: true,
        description: 'Call only when the user explicitly requests a PDF incident report. Compose complete incident-report Markdown from the current run chat and available evidence, label unknown facts explicitly, then persist the bounded, provenance-linked PDF. Do not claim the report exists unless this function succeeds.',
        origin: 'platform_native',
        capability: 'read',
        runtimeKind: 'function',
        visibility: {
          appearsInAssistantToolList: true,
          appearsInRunEnabledTools: true,
          appearsInToolCalls: true
        },
        config: {
          authorizationClass: 'internal_artifact'
        },
        permissions: {
          canEdit: false
        }
      }
    ]);
    assert.equal(gatewayFetch.mock.callCount(), 0);
  });

  it('lists every user-visible platform-native target-chat tool', async () => {
    installWorkspace('operator');
    repo.getTargetToolSetting = async () => null;

    const response = await callController(
      listTargetTools,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' })
    );

    const body = response.body as { items: Array<{ id: string; origin: string }> };
    const expectedIds = listWorkspaceNativeToolsForInvocationScope('target_chat')
      .map((tool) => tool.id)
      .sort();
    const actualIds = body.items
      .filter((tool) => tool.origin === 'platform_native')
      .map((tool) => tool.id)
      .sort();
    assert.deepEqual(actualIds, expectedIds);
  });

  it('keeps target tools listing independent from llm gateway availability', async () => {
    installWorkspace('operator');
    repo.getTargetToolSetting = async () => null;
    const gatewayFetch = mock.method(globalThis, 'fetch', async () => {
      throw new Error('llm-gateway unavailable');
    });

    const response = await callController(
      listTargetTools,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' })
    );

    const body = response.body as {
      items: Array<{
        id: string;
        readiness?: { learningAvailable: boolean; learningPausedReason: string | null };
      }>;
    };
    assert.equal(response.statusCode, 200);
    assert.equal(body.items.find((item) => item.id === 'web_search')?.id, 'web_search');
    assert.deepEqual(body.items.find((item) => item.id === 'target_insights')?.readiness, {
      learningAvailable: true,
      learningPausedReason: null
    });
    assert.equal(gatewayFetch.mock.callCount(), 0);
  });

  it('checks workspace default model policy without calling the llm gateway', async () => {
    installWorkspace('operator');
    repo.getTargetToolSetting = async () => null;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'not-an-allowed-model'
    });
    const gatewayFetch = mock.method(globalThis, 'fetch', async () => {
      throw new Error('tools catalog must not call the llm gateway');
    });

    const response = await callController(
      listTargetTools,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' })
    );

    const body = response.body as {
      items: Array<{
        id: string;
        readiness?: { learningAvailable: boolean; learningPausedReason: string | null };
      }>;
    };
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.items.find((item) => item.id === 'target_insights')?.readiness, {
      learningAvailable: false,
      learningPausedReason: 'model_not_allowed'
    });
    assert.equal(gatewayFetch.mock.callCount(), 0);
  });

  it('normalizes and persists web search domain filters', async () => {
    installWorkspace('admin');
    let persisted: {
      targetId: string;
      toolId: string;
      enabled: boolean;
      config: Record<string, unknown>;
    } | null = null;
    repo.getTargetToolSetting = async () => null;
    repo.upsertTargetToolSetting = async (targetId, toolId, enabled, config) => {
      persisted = { targetId, toolId, enabled, config };
      return {
        targetId,
        toolId,
        enabled,
        config,
        updatedAt: '2026-05-24T00:00:00.000Z'
      };
    };
    mock.method(webhooks, 'emit', () => undefined);

    const response = await callController(
      updateTargetToolSettings,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1', toolId: 'web_search' },
        {
          enabled: true,
          config: {
            domainFilters: {
              allowedDomains: [' Docs.Example.com ', 'Support.Example.com'],
              blockedDomains: ['Ads.Example.com']
            }
          }
        }
      )
    );

    const expectedConfig = {
      domainFilters: {
        allowedDomains: ['docs.example.com', 'support.example.com'],
        blockedDomains: ['ads.example.com']
      }
    };
    assert.equal(response.statusCode, 200);
    assert.deepEqual(persisted, {
      targetId: 'cluster-1',
      toolId: 'web_search',
      enabled: true,
      config: expectedConfig
    });
    assert.deepEqual(
      (response.body as { config: Record<string, unknown> }).config,
      expectedConfig
    );
    assert.equal((response.body as { capability: string }).capability, 'read');
    assert.equal((response.body as { runtimeKind: string }).runtimeKind, 'provider_native');
    assert.deepEqual((response.body as { visibility: Record<string, boolean> }).visibility, {
      appearsInAssistantToolList: true,
      appearsInRunEnabledTools: true,
      appearsInToolCalls: false
    });
  });

  it('preserves web search domain filters when a PATCH only toggles enabled', async () => {
    installWorkspace('admin');
    const existingConfig = {
      domainFilters: {
        allowedDomains: ['docs.example.com'],
        blockedDomains: ['ads.example.com']
      }
    };
    let persistedConfig: Record<string, unknown> | null = null;
    repo.getTargetToolSetting = async () => ({
      targetId: 'cluster-1',
      toolId: 'web_search',
      enabled: false,
      config: existingConfig,
      updatedAt: '2026-05-24T00:00:00.000Z'
    });
    repo.upsertTargetToolSetting = async (targetId, toolId, enabled, config) => {
      persistedConfig = config;
      return {
        targetId,
        toolId,
        enabled,
        config,
        updatedAt: '2026-05-24T00:00:00.000Z'
      };
    };
    mock.method(webhooks, 'emit', () => undefined);

    const response = await callController(
      updateTargetToolSettings,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1', toolId: 'web_search' },
        { enabled: true }
      )
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(persistedConfig, existingConfig);
    assert.deepEqual(
      (response.body as { config: Record<string, unknown> }).config,
      existingConfig
    );
  });

  it('requeues paused target insights checkpoints when Target Insights settings change', async () => {
    installWorkspace('admin');
    let requeueInput: { workspaceId: string; targetId?: string } | null = null;
    repo.getTargetToolSetting = async () => null;
    repo.upsertTargetToolSetting = async (targetId, toolId, enabled, config) => ({
      targetId,
      toolId,
      enabled,
      config,
      updatedAt: '2026-05-24T00:00:00.000Z'
    });
    repo.requeueTargetInsightsPausedCheckpoints = async (workspaceId, targetId) => {
      requeueInput = { workspaceId, targetId };
      return 3;
    };
    mock.method(webhooks, 'emit', () => undefined);

    const response = await callController(
      updateTargetToolSettings,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1', toolId: 'target_insights' },
        {
          enabled: true,
          config: {
            learning: {
              idleCheckpointDelayMinutes: 45,
              minimumObservationsBeforeGeneralization: 4,
              checkpointModel: { mode: 'workspace_default' }
            },
            retrieval: {
              maxSnippetsPerRetrieval: 5,
              maxSnippetSizeBytes: 2048
            }
          }
        }
      )
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requeueInput, { workspaceId: 'workspace-1', targetId: 'cluster-1' });
    assert.equal((response.body as { id: string }).id, 'target_insights');
  });

  it('rejects invalid web search domain filter values before persisting', async () => {
    installWorkspace('admin');
    repo.getTargetToolSetting = async () => null;
    repo.upsertTargetToolSetting = async () => {
      throw new Error('invalid domain config should not persist');
    };

    const cases: Array<{ name: string; config: Record<string, unknown>; message: RegExp }> = [
      {
        name: 'scheme',
        config: { domainFilters: { allowedDomains: ['https://docs.example.com'], blockedDomains: [] } },
        message: /without scheme/
      },
      {
        name: 'duplicate',
        config: { domainFilters: { allowedDomains: ['docs.example.com', 'DOCS.example.com'], blockedDomains: [] } },
        message: /duplicate domain "docs\.example\.com"/
      },
      {
        name: 'overlap',
        config: { domainFilters: { allowedDomains: ['docs.example.com'], blockedDomains: ['docs.example.com'] } },
        message: /cannot be both allowed and blocked/
      },
      {
        name: 'non-array',
        config: { domainFilters: { allowedDomains: 'docs.example.com', blockedDomains: [] } },
        message: /allowedDomains must be an array/
      }
    ];

    for (const testCase of cases) {
      const response = await callController(
        updateTargetToolSettings,
        createRequest(
          { workspaceId: 'workspace-1', targetId: 'cluster-1', toolId: 'web_search' },
          { enabled: true, config: testCase.config }
        )
      );

      assert.equal(response.statusCode, 400, testCase.name);
      assert.equal((response.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
      assert.match((response.body as { error: { message: string } }).error.message, testCase.message);
    }
  });

  it('rejects tool updates without an explicit enabled value', async () => {
    installWorkspace('admin');

    const response = await callController(
      updateTargetToolSettings,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1', toolId: 'web_search' },
        { config: { domainFilters: { allowedDomains: [], blockedDomains: [] } } }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    assert.match((response.body as { error: { message: string } }).error.message, /enabled is required/);
  });

  it('returns not found for unknown built-in tool ids', async () => {
    installWorkspace('admin');

    const response = await callController(
      updateTargetToolSettings,
      createRequest(
        { workspaceId: 'workspace-1', targetId: 'cluster-1', toolId: 'web_fetch' },
        { enabled: true }
      )
    );

    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error: { code: string } }).error.code, 'NOT_FOUND');
  });
});
