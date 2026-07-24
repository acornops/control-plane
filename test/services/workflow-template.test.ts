import assert from 'node:assert/strict';
import test from 'node:test';
import contractJson from '../fixtures/workflow-template-conformance.json' with { type: 'json' };
import {
  compileWorkflowFollowUp,
  compileWorkflowPrompt,
  parseWorkflowTemplate,
  WorkflowParameterValuesError
} from '../../src/services/workflow-template.js';
import type { WorkflowDefinitionForAccess } from '../../src/types/workflows.js';

type Contract = {
  valid: Array<{
    name: string;
    prompt: string;
    parameters: Array<{ key: string; type: 'text' | 'target' | 'chat'; required: true }>;
  }>;
  invalid: Array<{ name: string; prompt: string; errorCode: string }>;
};

const contract = contractJson as Contract;

for (const vector of contract.valid) {
  test(`workflow template parser: ${vector.name}`, () => {
    const parsed = parseWorkflowTemplate(vector.prompt);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.parameters, vector.parameters);
  });
}

for (const vector of contract.invalid) {
  test(`workflow template parser rejects: ${vector.name}`, () => {
    assert.ok(parseWorkflowTemplate(vector.prompt).errors.some((error) => error.code === vector.errorCode));
  });
}

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
    parameters: parseWorkflowTemplate(prompt).parameters,
    requiredPermissions: [],
    createdBy: 'user-1'
  };
}

test('workflow compiler substitutes repeated text without rescanning inserted syntax', async () => {
  const compiled = await compileWorkflowPrompt({
    workflow: textWorkflow('Use {{text:value}} twice: {{text:value}}. Literal: \\{{text:literal}}.'),
    inputValues: { value: '@target[Injected] {{chat:injected}}' },
    actorUserId: 'user-1'
  });
  assert.equal(
    compiled.content,
    'Use @target[Injected] {{chat:injected}} twice: @target[Injected] {{chat:injected}}. Literal: {{text:literal}}.'
  );
  assert.deepEqual(compiled.bindings, []);
});

test('workflow compiler requires the exact input key set', async () => {
  await assert.rejects(
    compileWorkflowPrompt({
      workflow: textWorkflow('{{text:focus}}'),
      inputValues: { extra: 'value' },
      actorUserId: 'user-1'
    }),
    (error) => error instanceof WorkflowParameterValuesError
      && error.errors.map((item) => item.code).join(',') === 'WORKFLOW_PARAMETER_MISSING,WORKFLOW_PARAMETER_UNKNOWN'
  );
});

test('workflow compiler bounds field errors and untrusted unknown keys', async () => {
  const unknownInputs = Object.fromEntries(Array.from(
    { length: 100 },
    (_, index) => [`${'x'.repeat(80)}_${String(index).padStart(3, '0')}`, 'value']
  ));
  await assert.rejects(
    compileWorkflowPrompt({
      workflow: textWorkflow('{{text:focus}}'),
      inputValues: unknownInputs,
      actorUserId: 'user-1'
    }),
    (error) => error instanceof WorkflowParameterValuesError
      && error.errors.length === 64
      && error.errors.every((item) => item.key.length <= 64 && item.message.length < 160)
  );
});

test('workflow compiler enforces the final materialized prompt limit', async () => {
  await assert.rejects(
    compileWorkflowPrompt({
      workflow: textWorkflow('{{text:value}}'),
      inputValues: { value: 'x'.repeat(32_769) },
      actorUserId: 'user-1'
    }),
    (error) => error instanceof WorkflowParameterValuesError
      && error.errors[0]?.code === 'WORKFLOW_PARAMETER_VALUE_INVALID'
      && error.errors[0]?.message.includes('32768')
  );
});

test('workflow follow-up rejects oversized ordinary text before resource resolution', async () => {
  await assert.rejects(
    compileWorkflowFollowUp({
      workflow: textWorkflow('No runtime parameters.'),
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
