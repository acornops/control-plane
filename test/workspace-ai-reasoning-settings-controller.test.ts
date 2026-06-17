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
        reasoningEffort: 'default'
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
    config.LLM_ALLOWED_REASONING_EFFORTS = 'default,low';
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
        reasoningEffort: 'default'
      });

      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'REASONING_SUMMARIES_DISABLED');
      assert.equal(attemptedPersist, false);
    } finally {
      config.LLM_REASONING_SUMMARIES_ENABLED = previousSummariesEnabled;
    }
  });
});
