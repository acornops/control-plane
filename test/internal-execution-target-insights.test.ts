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
  for (const targetType of ['kubernetes', 'virtual_machine'] as const) {
    for (const hasInsights of [true, false]) {
      it(`keeps ${targetType} context compatible with execution when retrieval ${hasInsights ? 'hits' : 'misses'}`, async () => {
        repo.getSession = async () => createSessionRecord({ conversationKind: 'target_chat', targetType });
        repo.getRun = async () => createRun({ status: 'running', targetType });
        repo.listMessages = async () => ({ items: [
          createMessage({ content: 'Investigate this unhealthy resource.' }),
          createMessage({ role: 'assistant', content: 'I will check the resource.' }),
          createMessage({ content: 'Please continue triage.' })
        ] });
        repo.getTargetToolSetting = async () => null;
        repo.searchTargetInsightsSnippets = async () => hasInsights ? [{
          entryId: 'insight-1', title: 'Prior diagnostic evidence',
          body: 'The last incident was caused by a missing image tag.',
          evidenceSummary: 'Image pull failed.', tags: ['image'], confidence: 0.9,
          observationCount: 2, score: 1, updatedAt: '2026-11-03T00:00:00.000Z'
        }] : [];
        const request = createRequest({ sessionId: 'session-1' });
        request.query = { run_id: 'run-1' };

        const response = await callController(getSessionContext, request);
        const context = response.body as {
          messages: Array<{ role: string; content: string }>;
          target_insights: { retrieval_status: string; snippets: Array<{ entry_id: string }> };
        };

        assert.equal(response.statusCode, 200);
        assert.deepEqual(context.messages.map((message) => message.role),
          hasInsights ? ['user', 'user', 'assistant', 'user'] : ['user', 'assistant', 'user']);
        assert.deepEqual(context.messages.slice(hasInsights ? 1 : 0), [
          { role: 'user', content: 'Investigate this unhealthy resource.' },
          { role: 'assistant', content: 'I will check the resource.' },
          { role: 'user', content: 'Please continue triage.' }
        ]);
        assert.equal(context.target_insights.retrieval_status, hasInsights ? 'hit' : 'miss');
        assert.deepEqual(context.target_insights.snippets.map((snippet) => snippet.entry_id),
          hasInsights ? ['insight-1'] : []);
        if (hasInsights) {
          assert.match(context.messages[0].content, /Prior diagnostic evidence/);
          assert.match(context.messages[0].content, /The last incident was caused by a missing image tag\./);
        }
      });
    }
  }

  it('continues session context assembly when Target Insights retrieval fails', async () => {
    repo.getSession = async () => createSessionRecord({ conversationKind: 'target_chat' });
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
    repo.getSession = async () => createSessionRecord({ conversationKind: 'target_chat' });
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
