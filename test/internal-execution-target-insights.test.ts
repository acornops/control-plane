import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getSessionContext } from '../src/controllers/internal-execution-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createMessage,
  createRequest,
  createRun,
  createSessionRecord,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('internal execution Target Insights context', () => {
  it('continues session context assembly when Target Insights retrieval fails', async () => {
    repo.getSession = async () => createSessionRecord();
    repo.getRun = async () => createRun({ status: 'running' });
    repo.listMessages = async () => ({ items: [createMessage({ content: 'diagnose registry 401' })] });
    repo.getTargetToolSetting = async () => null;
    repo.searchTargetInsightsSnippets = async () => {
      throw new Error('insights retrieval unavailable');
    };
    const request = createRequest({ sessionId: 'session-1' }) as ReturnType<typeof createRequest> & {
      query: Record<string, string>;
    };
    request.query = { run_id: 'run-1' };

    const response = await callController(getSessionContext, request);

    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { target_insights: { retrieval_status: string; snippets: unknown[] } }).target_insights, {
      retrieval_status: 'error',
      snippets: []
    });
    const messages = (response.body as { messages: Array<{ role: string; content: string }> }).messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content, 'diagnose registry 401');
  });

  it('marks Target Insights retrieval as skipped when the target setting is disabled', async () => {
    repo.getSession = async () => createSessionRecord();
    repo.getRun = async () => createRun({ status: 'running' });
    repo.listMessages = async () => ({ items: [createMessage({ content: 'diagnose crashloopbackoff' })] });
    repo.getTargetToolSetting = async () => ({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      toolId: 'target_insights',
      enabled: false,
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    repo.searchTargetInsightsSnippets = async () => {
      throw new Error('search should not be called');
    };
    const request = createRequest({ sessionId: 'session-1' }) as ReturnType<typeof createRequest> & {
      query: Record<string, string>;
    };
    request.query = { run_id: 'run-1' };

    const response = await callController(getSessionContext, request);

    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { target_insights: { retrieval_status: string; snippets: unknown[] } }).target_insights, {
      retrieval_status: 'skipped',
      snippets: []
    });
  });
});
