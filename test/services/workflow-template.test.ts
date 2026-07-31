import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileWorkflowFollowUp,
  compileWorkflowPrompt,
  parseWorkflowTemplate,
  WorkflowParameterValuesError,
  WorkflowTemplateValidationError
} from '../../src/services/workflow-template.js';
import type { WorkflowDefinitionForAccess } from '../../src/types/workflows.js';

function textWorkflow(prompt: string): WorkflowDefinitionForAccess {
  return {
    id: 'workflow-1',
    workspaceId: 'workspace-1',
    version: 1,
    origin: { type: 'manual' },
    name: 'Text workflow',
    status: 'active',
    prompt,
    agentIds: ['agent-1'],
    executionMode: 'direct',
    resourceRequirements: [],
    capabilityPolicy: {
      mode: 'read_only',
      restrictionMode: 'inherit',
      semanticCapabilityIds: [],
      contextGrants: [],
      maxRuntimeSeconds: 900,
      retentionDays: 30,
      approvalRequirements: []
    },
    parameters: [],
    requiredPermissions: [],
    createdBy: 'user-1'
  };
}

test('workflow prompts treat legacy parameter and reference syntax as plain text', async () => {
  const prompt = 'Inspect {{target:target}} and @target[Test Cluster].';
  const parsed = parseWorkflowTemplate(prompt);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.parameters, []);

  const compiled = await compileWorkflowPrompt({
    workflow: textWorkflow(prompt),
    inputValues: {},
    actorUserId: 'user-1'
  });
  assert.equal(compiled.content, prompt);
  assert.deepEqual(compiled.inputValues, {});
  assert.deepEqual(compiled.resourceInputValues, {});
  assert.deepEqual(compiled.parameters, []);
  assert.deepEqual(compiled.bindings, []);
});

test('workflow prompt compilation ignores legacy runtime input payloads', async () => {
  const compiled = await compileWorkflowPrompt({
    workflow: textWorkflow('Run the saved instructions.'),
    inputValues: { target: 'cluster-1', arbitrary: 'value' },
    actorUserId: 'user-1'
  });
  assert.equal(compiled.content, 'Run the saved instructions.');
  assert.deepEqual(compiled.inputValues, {});
});

test('workflow prompts retain their bounded plain-text limit', async () => {
  await assert.rejects(
    compileWorkflowPrompt({
      workflow: textWorkflow('x'.repeat(32_769)),
      inputValues: {},
      actorUserId: 'user-1'
    }),
    (error) => error instanceof WorkflowTemplateValidationError
      && error.errors[0]?.code === 'WORKFLOW_TEMPLATE_PROMPT_TOO_LONG'
  );
});

test('workflow follow-up rejects oversized ordinary text', async () => {
  await assert.rejects(
    compileWorkflowFollowUp({
      workflow: textWorkflow('Saved instructions.'),
      content: 'x'.repeat(32_769),
      resourceInputValues: {},
      actorUserId: 'user-1',
      workflowSessionId: 'session-1',
      initiatingMessageId: 'message-1'
    }),
    (error) => error instanceof WorkflowParameterValuesError
      && error.errors[0]?.code === 'WORKFLOW_PARAMETER_VALUE_INVALID'
      && error.errors[0]?.message.includes('32768')
  );
});
