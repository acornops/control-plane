import type {
  PromptReferenceBlocker,
  PromptResourceBinding,
  PromptResourceRequirement
} from '../types/prompt-resources.js';
import type {
  WorkflowDefinitionForAccess,
  WorkflowParameterDefinition
} from '../types/workflows.js';
import { PromptResourceProviderError } from './prompt-resources/errors.js';
import { promptResourceRegistry } from './prompt-resources/index.js';

export const MAX_WORKFLOW_RESOURCE_BINDINGS = 64;

function explicitResourceCounts(bindings: PromptResourceBinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  bindings
    .filter((binding) => binding.source !== 'implicit')
    .forEach((binding) => counts.set(binding.type, (counts.get(binding.type) || 0) + 1));
  return counts;
}

export function workflowTemplateResourceCardinalityBlockers(input: {
  parameters: WorkflowParameterDefinition[];
  concreteBindings: PromptResourceBinding[];
  requirements: PromptResourceRequirement[];
}): PromptReferenceBlocker[] {
  const blockers: PromptReferenceBlocker[] = [];
  const counts = explicitResourceCounts(input.concreteBindings);
  input.parameters
    .filter((parameter) => parameter.type === 'target' || parameter.type === 'chat')
    .forEach((parameter) => counts.set(parameter.type, (counts.get(parameter.type) || 0) + 1));

  const aggregateCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (aggregateCount > MAX_WORKFLOW_RESOURCE_BINDINGS) {
    blockers.push({
      code: 'PROMPT_REFERENCE_CARDINALITY',
      message: 'Prompt resource bindings exceed the aggregate run limit.',
      retryable: false
    });
  }
  for (const descriptor of promptResourceRegistry.descriptors().filter((item) => !item.implicit)) {
    const count = counts.get(descriptor.type) || 0;
    if (count < descriptor.minimum || count > descriptor.maximum) {
      blockers.push({
        code: 'PROMPT_REFERENCE_CARDINALITY',
        message: `Prompt permits between ${descriptor.minimum} and ${descriptor.maximum} ${descriptor.type} resources; found ${count}.`,
        type: descriptor.type,
        retryable: false
      });
    }
  }
  for (const requirement of input.requirements) {
    if (!promptResourceRegistry.provider(requirement.type)) {
      blockers.push({
        code: 'PROMPT_REFERENCE_UNKNOWN_TYPE',
        message: `Unknown prompt resource requirement type: ${requirement.type}.`,
        type: requirement.type,
        retryable: false
      });
      continue;
    }
    const count = counts.get(requirement.type) || 0;
    if (count < requirement.minimum || count > requirement.maximum) {
      blockers.push({
        code: 'PROMPT_REFERENCE_CARDINALITY',
        message: `Prompt requires between ${requirement.minimum} and ${requirement.maximum} ${requirement.type} resources; found ${count}.`,
        type: requirement.type,
        retryable: false
      });
    }
  }
  return blockers.sort((left, right) => (
    (left.type || '').localeCompare(right.type || '')
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  ));
}

export function validateWorkflowBindingCardinality(
  workflow: WorkflowDefinitionForAccess,
  bindings: PromptResourceBinding[]
): void {
  const explicit = bindings.filter((binding) => binding.source !== 'implicit');
  if (explicit.length > MAX_WORKFLOW_RESOURCE_BINDINGS) {
    throw new PromptResourceProviderError(
      'PROMPT_REFERENCE_CARDINALITY',
      'Prompt resource bindings exceed the aggregate run limit.'
    );
  }
  const counts = explicitResourceCounts(explicit);
  for (const descriptor of promptResourceRegistry.descriptors().filter((item) => !item.implicit)) {
    const count = counts.get(descriptor.type) || 0;
    if (count < descriptor.minimum || count > descriptor.maximum) {
      throw new PromptResourceProviderError(
        'PROMPT_REFERENCE_CARDINALITY',
        `Prompt permits between ${descriptor.minimum} and ${descriptor.maximum} ${descriptor.type} resources; found ${count}.`
      );
    }
  }
  for (const requirement of workflow.resourceRequirements || []) {
    const count = counts.get(requirement.type) || 0;
    if (count < requirement.minimum || count > requirement.maximum) {
      throw new PromptResourceProviderError(
        'PROMPT_REFERENCE_CARDINALITY',
        `Prompt requires between ${requirement.minimum} and ${requirement.maximum} ${requirement.type} resources; found ${count}.`
      );
    }
  }
}
