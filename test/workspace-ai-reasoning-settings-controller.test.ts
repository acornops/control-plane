import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import { updateWorkspaceAiSettings } from '../src/controllers/workspaces/ai-settings-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

function installAiCredentialGateway() {
  mock.method(globalThis, 'fetch', async (input) => {
    if (isWorkspaceAiCredentialStatusRequest(input)) {
      return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), {
        status: 200
      });
    }
    return new Response('unexpected request', { status: 500 });
  });
}

async function patchAiSettings(body: Record<string, string>) {
  return callController(
    updateWorkspaceAiSettings,
    createRequest(
      { workspaceId: 'workspace-1' },
      {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.5',
        ...body
      }
    )
  );
}

describe('workspace AI reasoning settings validation', () => {
  it('rejects reasoning summary modes disallowed by deployment policy', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    const previousAllowedModes = config.LLM_ALLOWED_REASONING_SUMMARY_MODES;
    config.LLM_ALLOWED_REASONING_SUMMARY_MODES = 'off,auto';
    let attemptedPersist = false;
    repo.upsertWorkspaceAiSettings = async () => {
      attemptedPersist = true;
    };

    try {
      const response = await patchAiSettings({
        reasoningSummaryMode: 'detailed',
        reasoningEffort: 'off'
      });

      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'REASONING_SUMMARY_MODE_NOT_ALLOWED');
      assert.equal(attemptedPersist, false);
    } finally {
      config.LLM_ALLOWED_REASONING_SUMMARY_MODES = previousAllowedModes;
    }
  });

  it('rejects reasoning efforts disallowed by deployment policy', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    const previousAllowedEfforts = config.LLM_ALLOWED_REASONING_EFFORTS;
    config.LLM_ALLOWED_REASONING_EFFORTS = 'low';
    let attemptedPersist = false;
    repo.upsertWorkspaceAiSettings = async () => {
      attemptedPersist = true;
    };

    try {
      const response = await patchAiSettings({
        reasoningSummaryMode: 'auto',
        reasoningEffort: 'high'
      });

      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'REASONING_EFFORT_NOT_ALLOWED');
      assert.equal(attemptedPersist, false);
    } finally {
      config.LLM_ALLOWED_REASONING_EFFORTS = previousAllowedEfforts;
    }
  });

  it('rejects enabled reasoning summaries when deployment policy disables summaries', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    const previousSummariesEnabled = config.LLM_REASONING_SUMMARIES_ENABLED;
    config.LLM_REASONING_SUMMARIES_ENABLED = false;
    let attemptedPersist = false;
    repo.upsertWorkspaceAiSettings = async () => {
      attemptedPersist = true;
    };

    try {
      const response = await patchAiSettings({
        reasoningSummaryMode: 'auto',
        reasoningEffort: 'off'
      });

      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'REASONING_SUMMARIES_DISABLED');
      assert.equal(attemptedPersist, false);
    } finally {
      config.LLM_REASONING_SUMMARIES_ENABLED = previousSummariesEnabled;
    }
  });

  it('falls back to off for omitted reasoning summary mode when summaries are disabled', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    const previousSummariesEnabled = config.LLM_REASONING_SUMMARIES_ENABLED;
    let persisted: Parameters<typeof repo.upsertWorkspaceAiSettings>[1] | undefined;
    repo.upsertWorkspaceAiSettings = async (_workspaceId, settings) => {
      persisted = settings;
    };

    try {
      config.LLM_REASONING_SUMMARIES_ENABLED = false;
      const response = await patchAiSettings({});

      assert.equal(response.statusCode, 200);
      assert.deepEqual(persisted, {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.5',
        reasoningSummaryMode: 'off',
        reasoningEffort: 'low'
      });
    } finally {
      config.LLM_REASONING_SUMMARIES_ENABLED = previousSummariesEnabled;
    }
  });

  it('preserves existing allowed reasoning summary mode and effort when input is omitted', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    const previousAllowedModes = config.LLM_ALLOWED_REASONING_SUMMARY_MODES;
    let persisted: Parameters<typeof repo.upsertWorkspaceAiSettings>[1] | undefined;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'concise',
      reasoningEffort: 'off'
    });
    repo.upsertWorkspaceAiSettings = async (_workspaceId, settings) => {
      persisted = settings;
    };

    try {
      config.LLM_ALLOWED_REASONING_SUMMARY_MODES = 'off,concise';
      const response = await patchAiSettings({});

      assert.equal(response.statusCode, 200);
      assert.deepEqual(persisted, {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.5',
        reasoningSummaryMode: 'concise',
        reasoningEffort: 'off'
      });
    } finally {
      config.LLM_ALLOWED_REASONING_SUMMARY_MODES = previousAllowedModes;
    }
  });

  it('preserves explicit off when auto is allowed and input is omitted', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    let persisted: Parameters<typeof repo.upsertWorkspaceAiSettings>[1] | undefined;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'off',
      reasoningEffort: 'off'
    });
    repo.upsertWorkspaceAiSettings = async (_workspaceId, settings) => {
      persisted = settings;
    };

    const response = await patchAiSettings({});

    assert.equal(response.statusCode, 200);
    assert.deepEqual(persisted, {
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'off',
      reasoningEffort: 'off'
    });
  });

  it('preserves an existing allowed reasoning effort when input is omitted', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    let persisted: Parameters<typeof repo.upsertWorkspaceAiSettings>[1] | undefined;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'auto',
      reasoningEffort: 'high'
    });
    repo.upsertWorkspaceAiSettings = async (_workspaceId, settings) => {
      persisted = settings;
    };

    const response = await patchAiSettings({});

    assert.equal(response.statusCode, 200);
    assert.deepEqual(persisted, {
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'auto',
      reasoningEffort: 'high'
    });
  });

  it('falls back to low when an omitted existing reasoning effort is no longer allowed', async () => {
    installWorkspace('admin');
    installAiCredentialGateway();
    const previousAllowedEfforts = config.LLM_ALLOWED_REASONING_EFFORTS;
    let persisted: Parameters<typeof repo.upsertWorkspaceAiSettings>[1] | undefined;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'auto',
      reasoningEffort: 'high'
    });
    repo.upsertWorkspaceAiSettings = async (_workspaceId, settings) => {
      persisted = settings;
    };

    try {
      config.LLM_ALLOWED_REASONING_EFFORTS = 'low';
      const response = await patchAiSettings({});

      assert.equal(response.statusCode, 200);
      assert.deepEqual(persisted, {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.5',
        reasoningSummaryMode: 'auto',
        reasoningEffort: 'low'
      });
    } finally {
      config.LLM_ALLOWED_REASONING_EFFORTS = previousAllowedEfforts;
    }
  });
});
