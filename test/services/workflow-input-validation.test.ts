import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { validateWorkflowInputs, WorkflowInputValidationError } from '../../src/services/workflow-input-validation.js';
import { defaultWorkflowDefinitions } from '../../src/store/repository-workflow-defaults.js';
import { repo } from '../../src/store/repository.js';
import { createSessionRecord } from '../helpers/controller-regression-fixtures.js';

const originalGetSession = repo.getSession;

afterEach(() => {
  repo.getSession = originalGetSession;
});

describe('workflow input validation', () => {
  it('accepts chat IDs bound to exact prompt references', async () => {
    const workflow = defaultWorkflowDefinitions('workspace-1').find((candidate) => candidate.id === 'incident-report-pdf')!;
    repo.getSession = async () => createSessionRecord({ id: 'chat-1', title: 'Payments incident' });

    await validateWorkflowInputs({
      workspaceId: 'workspace-1',
      workflow,
      inputs: { chatSessionIds: ['chat-1'] },
      content: 'Generate a report from @chat[Payments incident].'
    });
  });

  it('rejects a hidden chat binding that is absent from the prompt', async () => {
    const workflow = defaultWorkflowDefinitions('workspace-1').find((candidate) => candidate.id === 'incident-report-pdf')!;
    repo.getSession = async () => createSessionRecord({ id: 'chat-1', title: 'Payments incident' });

    await assert.rejects(
      validateWorkflowInputs({
        workspaceId: 'workspace-1',
        workflow,
        inputs: { chatSessionIds: ['chat-1'] },
        content: 'Generate a report from the selected chat.'
      }),
      (error: unknown) => error instanceof WorkflowInputValidationError
        && error.code === 'WORKFLOW_CHAT_MENTION_MISMATCH'
    );
  });
});
