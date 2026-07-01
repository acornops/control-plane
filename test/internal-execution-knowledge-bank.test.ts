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

describe('internal execution Knowledge Bank context', () => {
  it('continues session context assembly when Knowledge Bank retrieval fails', async () => {
    repo.getSession = async () => createSessionRecord();
    repo.getRun = async () => createRun({ status: 'running' });
    repo.listMessages = async () => ({ items: [createMessage({ content: 'diagnose registry 401' })] });
    repo.getTargetToolSetting = async () => null;
    repo.searchKnowledgeBankSnippets = async () => {
      throw new Error('knowledge retrieval unavailable');
    };
    const request = createRequest({ sessionId: 'session-1' }) as ReturnType<typeof createRequest> & {
      query: Record<string, string>;
    };
    request.query = { run_id: 'run-1' };

    const response = await callController(getSessionContext, request);

    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { knowledge_bank: { retrieval_status: string; snippets: unknown[] } }).knowledge_bank, {
      retrieval_status: 'error',
      snippets: []
    });
    const messages = (response.body as { messages: Array<{ role: string; content: string }> }).messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.content, 'diagnose registry 401');
  });

  it('marks Knowledge Bank retrieval as skipped when the target setting is disabled', async () => {
    repo.getSession = async () => createSessionRecord();
    repo.getRun = async () => createRun({ status: 'running' });
    repo.listMessages = async () => ({ items: [createMessage({ content: 'diagnose crashloopbackoff' })] });
    repo.getTargetToolSetting = async () => ({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      toolId: 'knowledge_bank',
      enabled: false,
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    repo.searchKnowledgeBankSnippets = async () => {
      throw new Error('search should not be called');
    };
    const request = createRequest({ sessionId: 'session-1' }) as ReturnType<typeof createRequest> & {
      query: Record<string, string>;
    };
    request.query = { run_id: 'run-1' };

    const response = await callController(getSessionContext, request);

    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { knowledge_bank: { retrieval_status: string; snippets: unknown[] } }).knowledge_bank, {
      retrieval_status: 'skipped',
      snippets: []
    });
  });
});
