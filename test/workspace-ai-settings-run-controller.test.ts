import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { postMessage } from '../src/controllers/sessions-controller.js';
import { config } from '../src/config.js';
import { repo } from '../src/store/repository.js';
import type { LlmProvider, ReasoningEffort } from '../src/types/domain.js';
import {
  callController,
  createMessage,
  createRequest,
  createRun,
  createSessionRecord,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { installAiCredentialGateway } from './helpers/workspace-ai-settings-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('workspace AI settings run creation', () => {
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
