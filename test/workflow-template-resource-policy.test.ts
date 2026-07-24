import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { PromptResourceProviderError } from '../src/services/prompt-resources/errors.js';
import { compileWorkflowPrompt } from '../src/services/workflow-template.js';
import { db } from '../src/infra/db.js';
import { getWorkflowDefinition } from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';
import { restoreControllerRegressionState } from './helpers/controller-regression-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});

afterEach(() => {
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('workflow template resource policy', () => {
  it('enforces workflow resource policy for concrete references and ID parameters', async () => {
    await db.query(
      `UPDATE workflow_definitions
       SET prompt='Inspect @target[Test Cluster].',
           resource_requirements=$3::jsonb
       WHERE workspace_id=$1 AND id=$2`,
      [
        'workspace-1',
        'cluster-triage',
        JSON.stringify([{
          type: 'target',
          minimum: 1,
          maximum: 1,
          requiredOperations: ['write'],
          constraints: { targetIds: ['cluster-1'], targetTypes: ['kubernetes'] }
        }])
      ]
    );
    const allowedWorkflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(allowedWorkflow);
    const allowed = await compileWorkflowPrompt({
      workflow: allowedWorkflow,
      inputValues: {},
      actorUserId: 'user-1'
    });
    assert.deepEqual(allowed.bindings.map((binding) => binding.operations), [['write']]);

    await db.query(
      `UPDATE workflow_definitions
       SET resource_requirements=$3::jsonb
       WHERE workspace_id=$1 AND id=$2`,
      [
        'workspace-1',
        'cluster-triage',
        JSON.stringify([{
          type: 'target',
          minimum: 1,
          maximum: 1,
          requiredOperations: ['read'],
          constraints: { targetIds: ['different-target'] }
        }])
      ]
    );
    const deniedWorkflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(deniedWorkflow);
    await assert.rejects(
      compileWorkflowPrompt({
        workflow: deniedWorkflow,
        inputValues: {},
        actorUserId: 'user-1'
      }),
      (error) => error instanceof PromptResourceProviderError
        && error.code === 'PROMPT_REFERENCE_DENIED'
    );

    const parameterWorkflow = {
      ...deniedWorkflow,
      prompt: 'Inspect {{target:target}}.',
      resourceRequirements: [{
        type: 'target',
        minimum: 1,
        maximum: 1,
        requiredOperations: ['read'],
        constraints: { targetIds: [] }
      }]
    };
    await assert.rejects(
      compileWorkflowPrompt({
        workflow: parameterWorkflow,
        inputValues: { target: 'cluster-2' },
        actorUserId: 'user-1'
      }),
      (error) => error instanceof PromptResourceProviderError
        && error.code === 'PROMPT_REFERENCE_NOT_FOUND'
    );

    await assert.rejects(
      compileWorkflowPrompt({
        workflow: {
          ...parameterWorkflow,
          prompt: 'Compare @target[Test Cluster] with {{target:target}}.',
          resourceRequirements: [{
            type: 'target',
            minimum: 1,
            maximum: 2,
            requiredOperations: ['read'],
            constraints: { targetIds: [] }
          }]
        },
        inputValues: { target: 'cluster-1' },
        actorUserId: 'user-1'
      }),
      (error) => error instanceof PromptResourceProviderError
        && error.code === 'PROMPT_REFERENCE_DUPLICATE'
    );
  });
});
