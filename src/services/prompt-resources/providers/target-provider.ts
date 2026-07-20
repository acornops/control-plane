import { listWorkflowTargetSnapshot } from '../../../store/repository-targets.js';
import type {
  PromptReferenceToken,
  PromptReferenceTypeDescriptor,
  PromptResolutionContext,
  PromptResourceAuthorization,
  PromptResourceBinding,
  PromptResourceCandidate,
  PromptResourceProvider,
  PromptResourceSuggestionContext
} from '../../../types/prompt-resources.js';
import { PromptResourceProviderError } from '../errors.js';
import type { TargetType } from '../../../types/domain.js';
import type { WorkflowDefinitionForAccess } from '../../../types/workflows.js';

export interface TargetPromptResourceConstraints {
  targetTypes: TargetType[];
  targetIds: string[];
}

const descriptor: PromptReferenceTypeDescriptor = {
  type: 'target',
  displayName: 'Target',
  description: 'A Kubernetes or virtual-machine target in this workspace.',
  icon: 'target',
  placeholderLabel: 'Target name',
  availability: 'available',
  minimum: 0,
  maximum: 1,
  allowPinnedReferences: true,
  provider: 'acornops.target-registry',
  providerVersion: '1'
};

export function workflowTargetPolicy(workflow: WorkflowDefinitionForAccess): TargetPromptResourceConstraints | undefined {
  const requirement = workflow.resourceRequirements.find((item) => item.type === descriptor.type);
  if (!requirement?.constraints) return undefined;
  const targetTypes = Array.isArray(requirement.constraints.targetTypes)
    ? requirement.constraints.targetTypes.filter((value): value is 'kubernetes' | 'virtual_machine' => value === 'kubernetes' || value === 'virtual_machine')
    : [];
  const targetIds = Array.isArray(requirement.constraints.targetIds)
    ? requirement.constraints.targetIds.filter((value): value is string => typeof value === 'string')
    : [];
  return { targetTypes, targetIds };
}

function normalized(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}

function requirements(context: PromptResolutionContext): { operations: string[]; constraints: Record<string, unknown> } {
  const matches = (context.requirements || []).filter((requirement) => requirement.type === descriptor.type);
  return {
    operations: [...new Set(matches.flatMap((requirement) => requirement.requiredOperations))].sort(),
    constraints: Object.assign({}, ...matches.map((requirement) => requirement.constraints || {}))
  };
}

export class TargetPromptResourceProvider implements PromptResourceProvider {
  descriptor(): PromptReferenceTypeDescriptor {
    return { ...descriptor };
  }

  async suggest(context: PromptResourceSuggestionContext): Promise<PromptResourceCandidate[]> {
    const query = normalized(context.query);
    return (await listWorkflowTargetSnapshot(context.workspaceId))
      .filter((target) => !query || normalized(target.name).includes(query))
      .slice(0, context.limit)
      .map((target) => ({
        type: descriptor.type,
        id: target.id,
        label: target.name,
        description: target.targetType === 'kubernetes' ? 'Kubernetes target' : 'Virtual machine',
        provider: descriptor.provider,
        availability: target.status === 'online' ? 'available' : 'unavailable',
        unavailableReason: target.status === 'online' ? undefined : `Target is ${target.status}.`,
        metadata: { targetType: target.targetType }
      }));
  }

  async resolve(token: PromptReferenceToken, context: PromptResolutionContext): Promise<PromptResourceCandidate> {
    const matches = (await listWorkflowTargetSnapshot(context.workspaceId))
      .filter((target) => normalized(target.name) === normalized(token.label));
    if (matches.length === 0) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_NOT_FOUND', 'The referenced target does not exist in this workspace.');
    }
    if (matches.length > 1) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_AMBIGUOUS', 'The referenced target label is ambiguous.');
    }
    const target = matches[0];
    return {
      type: descriptor.type,
      id: target.id,
      label: target.name,
      description: target.targetType === 'kubernetes' ? 'Kubernetes target' : 'Virtual machine',
      provider: descriptor.provider,
      availability: target.status === 'online' ? 'available' : 'unavailable',
      unavailableReason: target.status === 'online' ? undefined : `Target is ${target.status}.`,
      metadata: { targetType: target.targetType }
    };
  }

  async authorize(candidate: PromptResourceCandidate, context: PromptResolutionContext): Promise<PromptResourceAuthorization> {
    // Keep the aggregate repository behind a lazy boundary: repository-workflow-runs
    // imports prompt digest helpers, so a static import here would create a cycle.
    const { repo } = await import('../../../store/repository.js');
    const target = await repo.getTarget(context.workspaceId, candidate.id);
    if (!target) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'The referenced target is not available to this workspace.');
    }
    if (candidate.availability !== 'available' || target.status !== 'online') {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_UNAVAILABLE', candidate.unavailableReason || 'The referenced target is unavailable.', true);
    }
    const policy = requirements(context);
    const targetIds = Array.isArray(policy.constraints.targetIds)
      ? policy.constraints.targetIds.filter((value): value is string => typeof value === 'string')
      : [];
    const targetTypes = Array.isArray(policy.constraints.targetTypes)
      ? policy.constraints.targetTypes.filter((value): value is string => typeof value === 'string')
      : [];
    if ((targetIds.length > 0 && !targetIds.includes(target.id))
      || (targetTypes.length > 0 && !targetTypes.includes(target.targetType))) {
      throw new PromptResourceProviderError('PROMPT_REFERENCE_DENIED', 'The referenced target is outside this Workflow resource policy.');
    }
    return {
      operations: policy.operations.length > 0 ? policy.operations : ['read'],
      contextMode: 'routing_only',
      providerData: { targetType: target.targetType }
    };
  }

  async bind(
    candidate: PromptResourceCandidate,
    authorization: PromptResourceAuthorization,
    context: PromptResolutionContext
  ): Promise<Omit<PromptResourceBinding, 'bindingId'>> {
    return {
      type: candidate.type,
      resourceId: candidate.id,
      provider: descriptor.provider,
      providerVersion: descriptor.providerVersion,
      workspaceId: context.workspaceId,
      labelSnapshot: candidate.label,
      source: context.source || 'explicit',
      operations: authorization.operations,
      contextMode: authorization.contextMode,
      providerData: authorization.providerData
    };
  }

  projectRuntime(binding: PromptResourceBinding): Record<string, unknown> {
    return {
      targetRoute: {
        id: binding.resourceId,
        targetType: binding.providerData?.targetType
      }
    };
  }
}
