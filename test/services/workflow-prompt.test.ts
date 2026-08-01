import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileWorkflowFollowUp,
  compileWorkflowPrompt,
  WorkflowMessageContentError,
  WorkflowPromptValidationError
} from '../../src/services/workflow-prompt.js';
import type { WorkflowDefinitionForAccess } from '../../src/types/workflows.js';

function textWorkflow(prompt: string): WorkflowDefinitionForAccess {
  return {
    id: 'workflow-1',
    workspaceId: 'workspace-1',
    name: 'Text workflow',
    status: 'active',
    prompt,
    agentIds: ['agent-1'],
    executionMode: 'direct',
    capabilityPolicy: {
      mode: 'read_only',
      restrictionMode: 'inherit',
      semanticCapabilityIds: [],
      contextGrants: [],
      maxRuntimeSeconds: 900,
      retentionDays: 30,
      approvalRequirements: []
    },
    requiredPermissions: [],
    createdBy: 'user-1'
  };
}

test('workflow prompts keep placeholder-like text literal', async () => {
  const prompt = 'Inspect {{target:target}} and @target[Test Cluster].';
  const compiled = await compileWorkflowPrompt({
    workflow: textWorkflow(prompt),
    actorUserId: 'user-1'
  });
  assert.equal(compiled.content, prompt);
  assert.deepEqual(compiled.bindings, []);
});

test('workflow prompts retain their bounded plain-text limit', async () => {
  await assert.rejects(
    compileWorkflowPrompt({
      workflow: textWorkflow('x'.repeat(32_769)),
      actorUserId: 'user-1'
    }),
    (error) => error instanceof WorkflowPromptValidationError
      && error.errors[0]?.code === 'WORKFLOW_PROMPT_TOO_LONG'
  );
});

test('workflow follow-up rejects oversized ordinary text', async () => {
  await assert.rejects(
    compileWorkflowFollowUp({
      workflow: textWorkflow('Saved instructions.'),
      content: 'x'.repeat(32_769),
      actorUserId: 'user-1',
      workflowSessionId: 'session-1',
      initiatingMessageId: 'message-1'
    }),
    (error) => error instanceof WorkflowMessageContentError
      && error.code === 'WORKFLOW_MESSAGE_TOO_LONG'
      && error.message.includes('32768')
  );
});

test('workflow follow-up keeps target mentions as plain text without bindings', async () => {
  const compiled = await compileWorkflowFollowUp({
    workflow: textWorkflow('Saved instructions.'),
    content: 'Check @target[Production API] for errors.',
    actorUserId: 'user-1',
    workflowSessionId: 'session-1',
    initiatingMessageId: 'message-1'
  });

  assert.equal(compiled.content, 'Check @target[Production API] for errors.');
  assert.deepEqual(compiled.bindings, []);
});
