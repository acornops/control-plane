import type { WorkflowDefinitionForAccess } from '../types/workflows.js';

export const MAX_WORKFLOW_PROMPT_LENGTH = 32_768;

export interface WorkflowPromptError {
  code: 'WORKFLOW_PROMPT_TOO_LONG';
  message: string;
}

export class WorkflowMessageContentError extends Error {
  readonly code: 'WORKFLOW_MESSAGE_REQUIRED' | 'WORKFLOW_MESSAGE_TOO_LONG';

  constructor(code: WorkflowMessageContentError['code'], message: string) {
    super(message);
    this.name = 'WorkflowMessageContentError';
    this.code = code;
  }
}

export class WorkflowPromptValidationError extends Error {
  readonly errors: WorkflowPromptError[];

  constructor(errors: WorkflowPromptError[]) {
    super(errors[0]?.message || 'Workflow prompt is invalid.');
    this.name = 'WorkflowPromptValidationError';
    this.errors = errors;
  }
}

export function validateWorkflowPrompt(rawPrompt: string): string {
  const prompt = rawPrompt.normalize('NFC');
  if (prompt.length > MAX_WORKFLOW_PROMPT_LENGTH) {
    throw new WorkflowPromptValidationError([{
      code: 'WORKFLOW_PROMPT_TOO_LONG',
      message: `Prompt exceeds the ${MAX_WORKFLOW_PROMPT_LENGTH} character limit.`
    }]);
  }
  return prompt;
}

export interface CompiledWorkflowPrompt {
  content: string;
}

export function compileWorkflowPrompt(input: {
  workflow: WorkflowDefinitionForAccess;
}): CompiledWorkflowPrompt {
  return { content: validateWorkflowPrompt(input.workflow.prompt) };
}

export function compileWorkflowFollowUp(input: {
  content: string;
}): CompiledWorkflowPrompt {
  const content = input.content.normalize('NFC');
  if (!content.trim()) {
    throw new WorkflowMessageContentError('WORKFLOW_MESSAGE_REQUIRED', 'Follow-up content is required.');
  }
  if (content.length > MAX_WORKFLOW_PROMPT_LENGTH) {
    throw new WorkflowMessageContentError(
      'WORKFLOW_MESSAGE_TOO_LONG',
      `Follow-up content exceeds the ${MAX_WORKFLOW_PROMPT_LENGTH} character limit.`
    );
  }
  return { content };
}
