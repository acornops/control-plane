import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resolveWorkflowRepositoryScope, validateWorkflowInputs, WorkflowInputValidationError } from '../../src/services/workflow-input-validation.js';
import { repo } from '../../src/store/repository.js';
import type { WorkflowDefinitionForAccess } from '../../src/types/workflows.js';
import { createSessionRecord } from '../helpers/controller-regression-fixtures.js';

const originalGetSession = repo.getSession;

afterEach(() => {
  repo.getSession = originalGetSession;
});

const workflow: WorkflowDefinitionForAccess = {
  id: 'incident-report', workspaceId: 'workspace-1', version: 1,
  origin: { type: 'manual' }, name: 'Incident report', prompt: 'Generate an incident report.',
  agentIds: ['reporter-agent'], executionMode: 'direct',
  entryAgentId: 'reporter-agent',
  capabilityPolicy: {
    mode: 'read_only', semanticCapabilityIds: ['incident.report.generate'],
    contextGrants: ['selected_chat_sessions'], maxRuntimeSeconds: 300,
    retentionDays: 7, approvalRequirements: []
  },
  inputs: [{ name: 'chatSessionIds', label: 'Incident chats', type: 'chat_session_list', required: true }],
  requiredPermissions: ['view_data'], createdBy: 'user-1'
};

describe('workflow input validation', () => {
  it('normalizes one exact repository, ref, and pull request into run scope', () => {
    const repositoryWorkflow = {
      ...workflow,
      inputs: [{ name: 'repository', label: 'Repository', type: 'repository', required: true }]
    } satisfies WorkflowDefinitionForAccess;
    assert.deepEqual(resolveWorkflowRepositoryScope(repositoryWorkflow, {
      repository: { provider: 'github', repository: 'AcornOps/control-plane.git', ref: 'main', changeRequest: { type: 'pull_request', number: 42 } }
    }), {
      provider: 'github', repository: 'AcornOps/control-plane', ref: 'main', changeRequestNumber: 42
    });
  });

  it('rejects repository URLs and traversal instead of widening scope', () => {
    const repositoryWorkflow = {
      ...workflow,
      inputs: [{ name: 'repository', label: 'Repository', type: 'repository', required: true }]
    } satisfies WorkflowDefinitionForAccess;
    assert.throws(
      () => resolveWorkflowRepositoryScope(repositoryWorkflow, { repository: { provider: 'gitlab', repository: 'https://gitlab.com/acornops/control-plane' } }),
      (error: unknown) => error instanceof WorkflowInputValidationError && error.code === 'WORKFLOW_REPOSITORY_INVALID'
    );
  });

  it('accepts chat IDs bound to exact prompt references', async () => {
    repo.getSession = async () => createSessionRecord({ id: 'chat-1', title: 'Payments incident' });

    await validateWorkflowInputs({
      workspaceId: 'workspace-1',
      workflow,
      inputs: { chatSessionIds: ['chat-1'] },
      content: 'Generate a report from @chat[Payments incident].'
    });
  });

  it('rejects a hidden chat binding that is absent from the prompt', async () => {
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
