import type {
  PromptResourceBinding,
  PromptResourceBindingSource
} from '../types/prompt-resources.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import {
  digestBindings,
  digestPrompt
} from './prompt-resources/index.js';

export {
  MAX_WORKFLOW_RESOURCE_BINDINGS,
  workflowPromptResourceCardinalityBlockers
} from './workflow-prompt-cardinality.js';

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
  bindings: PromptResourceBinding[];
  promptDigest: string;
  bindingDigest: string;
  resolvedAt: string;
}

function plainPrompt(content: string): CompiledWorkflowPrompt {
  const bindings: PromptResourceBinding[] = [];
  return {
    content,
    bindings,
    promptDigest: digestPrompt(content),
    bindingDigest: digestBindings(bindings),
    resolvedAt: new Date().toISOString()
  };
}

export async function compileWorkflowPrompt(input: {
  workflow: WorkflowDefinitionForAccess;
  actorUserId: string;
  source?: PromptResourceBindingSource;
  workflowSessionId?: string;
  initiatingMessageId?: string;
}): Promise<CompiledWorkflowPrompt> {
  return plainPrompt(validateWorkflowPrompt(input.workflow.prompt));
}

export async function compileWorkflowFollowUp(input: {
  workflow: WorkflowDefinitionForAccess;
  content: string;
  actorUserId: string;
  workflowSessionId: string;
  initiatingMessageId: string;
}): Promise<CompiledWorkflowPrompt> {
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
  return plainPrompt(content);
}
