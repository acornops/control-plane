import type {
  PromptResourceBinding,
  PromptResourceBindingSource
} from '../types/prompt-resources.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import {
  digestBindings,
  digestPrompt,
  promptResourceRegistry
} from './prompt-resources/index.js';
import { PromptResourceProviderError } from './prompt-resources/errors.js';

export {
  MAX_WORKFLOW_RESOURCE_BINDINGS,
  workflowTemplateResourceCardinalityBlockers
} from './workflow-template-cardinality.js';

export const MAX_WORKFLOW_PROMPT_LENGTH = 32_768;
/** Deprecated database columns still require a stable 64-character value. */

export interface WorkflowTemplateError {
  code: 'WORKFLOW_TEMPLATE_PROMPT_TOO_LONG';
  message: string;
  start?: number;
  end?: number;
  key?: string;
}

interface TextSegment {
  kind: 'text';
  value: string;
}

export interface ParsedWorkflowTemplate {
  prompt: string;
  errors: WorkflowTemplateError[];
  segments: TextSegment[];
}

export class WorkflowMessageContentError extends Error {
  readonly code: 'WORKFLOW_MESSAGE_REQUIRED' | 'WORKFLOW_MESSAGE_TOO_LONG';

  constructor(code: WorkflowMessageContentError['code'], message: string) {
    super(message);
    this.name = 'WorkflowMessageContentError';
    this.code = code;
  }
}

export class WorkflowTemplateValidationError extends Error {
  readonly errors: WorkflowTemplateError[];

  constructor(errors: WorkflowTemplateError[]) {
    super(errors[0]?.message || 'Workflow prompt is invalid.');
    this.name = 'WorkflowTemplateValidationError';
    this.errors = errors.slice(0, 64);
  }
}

/**
 * Workflow prompts are plain text. The legacy function name remains temporarily
 * as an internal compatibility boundary for controllers and persisted records.
 */
export function parseWorkflowTemplate(rawPrompt: string): ParsedWorkflowTemplate {
  const prompt = rawPrompt.normalize('NFC');
  const errors: WorkflowTemplateError[] = prompt.length > MAX_WORKFLOW_PROMPT_LENGTH
    ? [{
        code: 'WORKFLOW_TEMPLATE_PROMPT_TOO_LONG',
        message: `Prompt exceeds the ${MAX_WORKFLOW_PROMPT_LENGTH} character limit.`
      }]
    : [];

  return {
    prompt,
    errors,
    segments: prompt ? [{ kind: 'text', value: prompt }] : []
  };
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
  const parsed = parseWorkflowTemplate(input.workflow.prompt);
  if (parsed.errors.length > 0) throw new WorkflowTemplateValidationError(parsed.errors);
  return plainPrompt(parsed.prompt);
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
  const contextResolution = await promptResourceRegistry.resolve('', {
    workspaceId: input.workflow.workspaceId,
    actorUserId: input.actorUserId,
    workflowId: input.workflow.id,
    workflowSessionId: input.workflowSessionId,
    initiatingMessageId: input.initiatingMessageId,
    source: 'implicit',
    mode: 'launch',
    requirements: []
  }, {
    enforceCardinality: false,
    includeImplicit: true
  });
  if (contextResolution.blockers.length > 0) {
    const first = contextResolution.blockers[0];
    throw new PromptResourceProviderError(first.code, first.message, first.retryable);
  }
  return {
    content,
    bindings: contextResolution.bindings,
    promptDigest: digestPrompt(content),
    bindingDigest: digestBindings(contextResolution.bindings),
    resolvedAt: contextResolution.resolvedAt
  };
}
