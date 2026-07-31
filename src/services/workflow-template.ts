import type {
  PromptResourceBinding,
  PromptResourceBindingSource
} from '../types/prompt-resources.js';
import type {
  WorkflowDefinitionForAccess,
  WorkflowParameterDefinition
} from '../types/workflows.js';
import {
  digestBindings,
  digestPrompt
} from './prompt-resources/index.js';

export {
  MAX_WORKFLOW_RESOURCE_BINDINGS,
  workflowTemplateResourceCardinalityBlockers
} from './workflow-template-cardinality.js';

export const WORKFLOW_PARAMETER_TYPES = [] as const;
export const MAX_WORKFLOW_PROMPT_LENGTH = 32_768;

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
  parameters: WorkflowParameterDefinition[];
  errors: WorkflowTemplateError[];
  segments: TextSegment[];
}

export interface WorkflowParameterValueError {
  key: string;
  code:
    | 'WORKFLOW_PARAMETER_MISSING'
    | 'WORKFLOW_PARAMETER_UNKNOWN'
    | 'WORKFLOW_PARAMETER_EMPTY'
    | 'WORKFLOW_PARAMETER_VALUE_INVALID';
  message: string;
}

/**
 * Retained as an execution-content validation error for API compatibility.
 * Workflow runtime parameters no longer exist.
 */
export class WorkflowParameterValuesError extends Error {
  readonly errors: WorkflowParameterValueError[];

  constructor(errors: WorkflowParameterValueError[]) {
    super('Workflow content is invalid.');
    this.name = 'WorkflowParameterValuesError';
    this.errors = errors.slice(0, 64);
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
    parameters: [],
    errors,
    segments: prompt ? [{ kind: 'text', value: prompt }] : []
  };
}

export function workflowParameters(prompt: string): WorkflowParameterDefinition[] {
  const parsed = parseWorkflowTemplate(prompt);
  if (parsed.errors.length > 0) throw new WorkflowTemplateValidationError(parsed.errors);
  return [];
}

export function workflowParameterSignature(_parameters: WorkflowParameterDefinition[]): string {
  return digestPrompt('[]');
}

export interface CompiledWorkflowPrompt {
  content: string;
  inputValues: Record<string, string>;
  resourceInputValues: Record<string, string>;
  parameters: WorkflowParameterDefinition[];
  bindings: PromptResourceBinding[];
  promptDigest: string;
  bindingDigest: string;
  resolvedAt: string;
}

function plainPrompt(content: string): CompiledWorkflowPrompt {
  const bindings: PromptResourceBinding[] = [];
  return {
    content,
    inputValues: {},
    resourceInputValues: {},
    parameters: [],
    bindings,
    promptDigest: digestPrompt(content),
    bindingDigest: digestBindings(bindings),
    resolvedAt: new Date().toISOString()
  };
}

export async function compileWorkflowPrompt(input: {
  workflow: WorkflowDefinitionForAccess;
  inputValues?: Record<string, unknown>;
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
  launchWorkflow?: WorkflowDefinitionForAccess;
  content: string;
  resourceInputValues?: Record<string, string>;
  actorUserId: string;
  workflowSessionId: string;
  initiatingMessageId: string;
}): Promise<CompiledWorkflowPrompt> {
  const content = input.content.normalize('NFC');
  if (!content.trim()) {
    throw new WorkflowParameterValuesError([{
      key: '',
      code: 'WORKFLOW_PARAMETER_VALUE_INVALID',
      message: 'Follow-up content is required.'
    }]);
  }
  if (content.length > MAX_WORKFLOW_PROMPT_LENGTH) {
    throw new WorkflowParameterValuesError([{
      key: '',
      code: 'WORKFLOW_PARAMETER_VALUE_INVALID',
      message: `Follow-up content exceeds the ${MAX_WORKFLOW_PROMPT_LENGTH} character limit.`
    }]);
  }
  return plainPrompt(content);
}
