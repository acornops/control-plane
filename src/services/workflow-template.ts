import type {
  PromptResolutionContext,
  PromptResourceBinding,
  PromptResourceBindingSource,
  PromptResourceCandidate
} from '../types/prompt-resources.js';
import type {
  WorkflowDefinitionForAccess,
  WorkflowParameterDefinition,
  WorkflowParameterType
} from '../types/workflows.js';
import {
  digestBindings,
  digestPrompt,
  formatPromptReference,
  parsePromptReferences,
  promptResourceRegistry
} from './prompt-resources/index.js';
import { PromptResourceProviderError } from './prompt-resources/errors.js';
import { validateWorkflowBindingCardinality } from './workflow-template-cardinality.js';

export {
  MAX_WORKFLOW_RESOURCE_BINDINGS,
  workflowTemplateResourceCardinalityBlockers
} from './workflow-template-cardinality.js';

export const WORKFLOW_PARAMETER_TYPES = ['text', 'target', 'chat'] as const;
export const MAX_WORKFLOW_PROMPT_LENGTH = 32_768;

const PARAMETER_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const PARAMETER_TYPE = new Set<string>(WORKFLOW_PARAMETER_TYPES);

export interface WorkflowTemplateError {
  code:
    | 'WORKFLOW_TEMPLATE_EXPRESSION_INVALID'
    | 'WORKFLOW_TEMPLATE_EXPRESSION_UNCLOSED'
    | 'WORKFLOW_TEMPLATE_PARAMETER_CONFLICT'
    | 'WORKFLOW_TEMPLATE_PROMPT_TOO_LONG'
    | 'WORKFLOW_TEMPLATE_REFERENCE_INVALID';
  message: string;
  start?: number;
  end?: number;
  key?: string;
}

interface TextSegment {
  kind: 'text';
  value: string;
}

interface ParameterSegment {
  kind: 'parameter';
  key: string;
  type: WorkflowParameterType;
  start: number;
  end: number;
}

type WorkflowTemplateSegment = TextSegment | ParameterSegment;

export interface ParsedWorkflowTemplate {
  prompt: string;
  parameters: WorkflowParameterDefinition[];
  errors: WorkflowTemplateError[];
  segments: WorkflowTemplateSegment[];
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

export class WorkflowParameterValuesError extends Error {
  readonly errors: WorkflowParameterValueError[];

  constructor(errors: WorkflowParameterValueError[]) {
    super('One or more workflow parameter values are invalid.');
    this.name = 'WorkflowParameterValuesError';
    this.errors = errors.slice(0, 64);
  }
}

export class WorkflowTemplateValidationError extends Error {
  readonly errors: WorkflowTemplateError[];

  constructor(errors: WorkflowTemplateError[]) {
    super(errors[0]?.message || 'Workflow prompt template is invalid.');
    this.name = 'WorkflowTemplateValidationError';
    this.errors = errors.slice(0, 64);
  }
}

function textSegment(segments: WorkflowTemplateSegment[], value: string): void {
  if (!value) return;
  const last = segments.at(-1);
  if (last?.kind === 'text') last.value += value;
  else segments.push({ kind: 'text', value });
}

export function parseWorkflowTemplate(rawPrompt: string): ParsedWorkflowTemplate {
  const prompt = rawPrompt.normalize('NFC');
  const segments: WorkflowTemplateSegment[] = [];
  const errors: WorkflowTemplateError[] = [];
  const parameters: WorkflowParameterDefinition[] = [];
  const typesByKey = new Map<string, WorkflowParameterType>();

  if (prompt.length > MAX_WORKFLOW_PROMPT_LENGTH) {
    return {
      prompt,
      parameters,
      segments,
      errors: [{
        code: 'WORKFLOW_TEMPLATE_PROMPT_TOO_LONG',
        message: `Prompt exceeds the ${MAX_WORKFLOW_PROMPT_LENGTH} character limit.`
      }]
    };
  }

  let cursor = 0;
  while (cursor < prompt.length) {
    if (prompt[cursor] === '\\' && prompt.slice(cursor + 1, cursor + 3) === '{{') {
      textSegment(segments, '{{');
      cursor += 3;
      continue;
    }
    if (prompt.slice(cursor, cursor + 2) !== '{{') {
      textSegment(segments, prompt[cursor]);
      cursor += 1;
      continue;
    }

    const start = cursor;
    const close = prompt.indexOf('}}', cursor + 2);
    if (close < 0) {
      errors.push({
        code: 'WORKFLOW_TEMPLATE_EXPRESSION_UNCLOSED',
        message: 'Workflow parameter expression is missing a closing }}.',
        start,
        end: prompt.length
      });
      textSegment(segments, prompt.slice(cursor));
      break;
    }

    const expression = prompt.slice(cursor + 2, close);
    const separator = expression.indexOf(':');
    const typeValue = separator < 0 ? '' : expression.slice(0, separator);
    const key = separator < 0 ? '' : expression.slice(separator + 1);
    const valid = separator > 0
      && separator === expression.lastIndexOf(':')
      && PARAMETER_TYPE.has(typeValue)
      && PARAMETER_KEY.test(key)
      && !/\s/.test(expression);
    if (!valid) {
      errors.push({
        code: 'WORKFLOW_TEMPLATE_EXPRESSION_INVALID',
        message: 'Workflow parameters must use {{text:key}}, {{target:key}}, or {{chat:key}} with a lowercase snake_case key.',
        start,
        end: close + 2,
        ...(key ? { key } : {})
      });
      textSegment(segments, prompt.slice(start, close + 2));
      cursor = close + 2;
      continue;
    }

    const type = typeValue as WorkflowParameterType;
    const existingType = typesByKey.get(key);
    if (existingType && existingType !== type) {
      errors.push({
        code: 'WORKFLOW_TEMPLATE_PARAMETER_CONFLICT',
        message: `Workflow parameter ${key} is used as both ${existingType} and ${type}.`,
        start,
        end: close + 2,
        key
      });
    } else if (!existingType) {
      typesByKey.set(key, type);
      parameters.push({ key, type, required: true });
    }
    segments.push({ kind: 'parameter', key, type, start, end: close + 2 });
    cursor = close + 2;
  }

  for (const error of parsePromptReferences(prompt).errors) {
    errors.push({
      code: 'WORKFLOW_TEMPLATE_REFERENCE_INVALID',
      message: error.message,
      start: error.start,
      end: error.end
    });
  }

  return { prompt, parameters, errors, segments };
}

export function workflowParameters(prompt: string): WorkflowParameterDefinition[] {
  const parsed = parseWorkflowTemplate(prompt);
  if (parsed.errors.length > 0) throw new WorkflowTemplateValidationError(parsed.errors);
  return parsed.parameters;
}

export function workflowParameterSignature(parameters: WorkflowParameterDefinition[]): string {
  return digestPrompt(JSON.stringify(parameters.map((parameter) => ({
    key: parameter.key,
    type: parameter.type,
    required: true
  }))));
}

function validateInputValues(
  parameters: WorkflowParameterDefinition[],
  inputValues: Record<string, unknown>
): Record<string, string> {
  const errors: WorkflowParameterValueError[] = [];
  const addError = (error: WorkflowParameterValueError): void => {
    if (errors.length < 64) errors.push(error);
  };
  const expected = new Map(parameters.map((parameter) => [parameter.key, parameter]));
  const normalized: Record<string, string> = {};

  for (const parameter of parameters) {
    if (!Object.hasOwn(inputValues, parameter.key)) {
      addError({
        key: parameter.key,
        code: 'WORKFLOW_PARAMETER_MISSING',
        message: `${parameter.key} is required.`
      });
      continue;
    }
    const value = inputValues[parameter.key];
    if (typeof value !== 'string') {
      addError({
        key: parameter.key,
        code: 'WORKFLOW_PARAMETER_VALUE_INVALID',
        message: `${parameter.key} must be a string.`
      });
      continue;
    }
    const next = value.normalize('NFC');
    if (!next.trim()) {
      addError({
        key: parameter.key,
        code: 'WORKFLOW_PARAMETER_EMPTY',
        message: `${parameter.key} cannot be empty.`
      });
      continue;
    }
    normalized[parameter.key] = parameter.type === 'text' ? next : next.trim();
  }

  for (const key of Object.keys(inputValues).sort()) {
    if (errors.length >= 64) break;
    if (!expected.has(key)) {
      const boundedKey = key.slice(0, 64);
      addError({
        key: boundedKey,
        code: 'WORKFLOW_PARAMETER_UNKNOWN',
        message: `${boundedKey} is not declared by this workflow.`
      });
    }
  }

  if (errors.length > 0) throw new WorkflowParameterValuesError(errors);
  return normalized;
}

function resourceKey(binding: PromptResourceBinding): string {
  return `${binding.provider}\u0000${binding.type}\u0000${binding.resourceId}`;
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

export async function compileWorkflowPrompt(input: {
  workflow: WorkflowDefinitionForAccess;
  inputValues: Record<string, unknown>;
  actorUserId: string;
  source?: PromptResourceBindingSource;
  workflowSessionId?: string;
  initiatingMessageId?: string;
}): Promise<CompiledWorkflowPrompt> {
  const parsed = parseWorkflowTemplate(input.workflow.prompt);
  if (parsed.errors.length > 0) throw new WorkflowTemplateValidationError(parsed.errors);
  const inputValues = validateInputValues(parsed.parameters, input.inputValues);
  const context: PromptResolutionContext = {
    workspaceId: input.workflow.workspaceId,
    actorUserId: input.actorUserId,
    workflowId: input.workflow.id,
    workflowSessionId: input.workflowSessionId,
    initiatingMessageId: input.initiatingMessageId,
    source: input.source || 'explicit',
    mode: 'launch',
    requirements: input.workflow.resourceRequirements || []
  };

  const concreteResolution = await promptResourceRegistry.resolve(parsed.prompt, {
    ...context
  }, {
    enforceCardinality: false,
    includeImplicit: false
  });
  if (concreteResolution.blockers.length > 0) {
    const first = concreteResolution.blockers[0];
    throw new PromptResourceProviderError(first.code, first.message, first.retryable);
  }

  const candidates = new Map<string, PromptResourceCandidate>();
  const parameterBindings: PromptResourceBinding[] = [];
  const resourceInputValues: Record<string, string> = {};
  for (const parameter of parsed.parameters) {
    if (parameter.type === 'text') continue;
    const resolved = await promptResourceRegistry.resolveById(
      parameter.type,
      inputValues[parameter.key],
      context
    );
    candidates.set(parameter.key, resolved.candidate);
    parameterBindings.push(resolved.binding);
    resourceInputValues[parameter.key] = resolved.binding.resourceId;
  }

  const bindings = [...concreteResolution.bindings, ...parameterBindings];
  const seen = new Set<string>();
  for (const binding of bindings.filter((value) => value.source !== 'implicit')) {
    const key = resourceKey(binding);
    if (seen.has(key)) {
      throw new PromptResourceProviderError(
        'PROMPT_REFERENCE_DUPLICATE',
        'The same prompt resource is selected by more than one workflow parameter or reference.'
      );
    }
    seen.add(key);
  }
  validateWorkflowBindingCardinality(input.workflow, bindings);

  let content = '';
  for (const segment of parsed.segments) {
    if (segment.kind === 'text') {
      content += segment.value;
      continue;
    }
    const value = inputValues[segment.key];
    content += segment.type === 'text'
      ? value
      : formatPromptReference(segment.type, candidates.get(segment.key)?.label || segment.key);
  }
  if (content.length > MAX_WORKFLOW_PROMPT_LENGTH) {
    throw new WorkflowParameterValuesError([{
      key: '',
      code: 'WORKFLOW_PARAMETER_VALUE_INVALID',
      message: `Materialized workflow prompt exceeds the ${MAX_WORKFLOW_PROMPT_LENGTH} character limit.`
    }]);
  }

  return {
    content,
    inputValues,
    resourceInputValues,
    parameters: parsed.parameters,
    bindings,
    promptDigest: digestPrompt(content),
    bindingDigest: digestBindings(bindings),
    resolvedAt: new Date().toISOString()
  };
}

export async function compileWorkflowFollowUp(input: {
  workflow: WorkflowDefinitionForAccess;
  launchWorkflow?: WorkflowDefinitionForAccess;
  content: string;
  resourceInputValues: Record<string, string>;
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
  const launchWorkflow = input.launchWorkflow || input.workflow;
  const parsed = parseWorkflowTemplate(launchWorkflow.prompt);
  if (parsed.errors.length > 0) throw new WorkflowTemplateValidationError(parsed.errors);
  const resourceParameters = parsed.parameters.filter((parameter) => parameter.type !== 'text');
  const resourceValues: Record<string, string> = {};
  for (const parameter of resourceParameters) {
    const value = input.resourceInputValues[parameter.key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new WorkflowParameterValuesError([{
        key: parameter.key,
        code: 'WORKFLOW_PARAMETER_MISSING',
        message: `${parameter.key} is required to continue this workflow session.`
      }]);
    }
    resourceValues[parameter.key] = value.trim();
  }

  const context: PromptResolutionContext = {
    workspaceId: input.workflow.workspaceId,
    actorUserId: input.actorUserId,
    workflowId: input.workflow.id,
    workflowSessionId: input.workflowSessionId,
    initiatingMessageId: input.initiatingMessageId,
    source: 'explicit',
    mode: 'launch',
    requirements: input.workflow.resourceRequirements || []
  };
  const savedConcreteResolution = await promptResourceRegistry.resolve(parsed.prompt, {
    ...context
  }, {
    enforceCardinality: false,
    includeImplicit: false
  });
  if (savedConcreteResolution.blockers.length > 0) {
    const first = savedConcreteResolution.blockers[0];
    throw new PromptResourceProviderError(first.code, first.message, first.retryable);
  }
  const followUpConcreteResolution = await promptResourceRegistry.resolve(content, {
    ...context
  }, {
    enforceCardinality: false,
    includeImplicit: true
  });
  if (followUpConcreteResolution.blockers.length > 0) {
    const first = followUpConcreteResolution.blockers[0];
    throw new PromptResourceProviderError(first.code, first.message, first.retryable);
  }

  const inheritedBindings: PromptResourceBinding[] = [];
  for (const parameter of resourceParameters) {
    inheritedBindings.push((await promptResourceRegistry.resolveById(
      parameter.type,
      resourceValues[parameter.key],
      context
    )).binding);
  }
  const bindings = [
    ...savedConcreteResolution.bindings,
    ...followUpConcreteResolution.bindings,
    ...inheritedBindings
  ];
  const seen = new Set<string>();
  const uniqueBindings = bindings.filter((binding) => {
    const key = resourceKey(binding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  validateWorkflowBindingCardinality(input.workflow, uniqueBindings);
  return {
    content,
    inputValues: resourceValues,
    resourceInputValues: resourceValues,
    parameters: resourceParameters,
    bindings: uniqueBindings,
    promptDigest: digestPrompt(content),
    bindingDigest: digestBindings(uniqueBindings),
    resolvedAt: new Date().toISOString()
  };
}
