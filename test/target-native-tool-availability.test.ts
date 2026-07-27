import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import { listTargetTools } from '../src/controllers/workspaces/target-native-tool-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target native tool availability', () => {
  it('preserves Web Search preference while reporting it unavailable for OpenAI Chat Completions', async () => {
    installWorkspace('operator');
    repo.getTargetToolSetting = async () => null;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      reasoningSummaryMode: 'auto',
      reasoningEffort: 'medium'
    });
    const previousSurface = config.LLM_PROVIDER_OPENAI_API_SURFACE;
    config.LLM_PROVIDER_OPENAI_API_SURFACE = 'chat_completions';
    try {
      const response = await callController(
        listTargetTools,
        createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' })
      );
      const body = response.body as {
        items: Array<{
          id: string;
          enabled: boolean;
          availability?: { available: boolean; unavailableReason: string | null };
        }>;
      };
      const webSearch = body.items.find((item) => item.id === 'web_search');
      assert.equal(response.statusCode, 200);
      assert.equal(webSearch?.enabled, true);
      assert.deepEqual(webSearch?.availability, {
        available: false,
        unavailableReason: 'openai_responses_api_required'
      });
    } finally {
      config.LLM_PROVIDER_OPENAI_API_SURFACE = previousSurface;
    }
  });
});
