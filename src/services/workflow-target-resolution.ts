import { repo } from '../store/repository.js';
import {
  isTargetType,
  KUBERNETES_TARGET_TYPE,
  VIRTUAL_MACHINE_TARGET_TYPE,
  type TargetSummary,
  type TargetType
} from '../types/domain.js';
import type { WorkflowDefinitionForAccess, WorkflowTargetBinding } from '../types/workflows.js';
import { decodeCursor } from '../utils/pagination.js';

export class WorkflowTargetResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkflowTargetResolutionError';
  }
}

function bindingTargetType(binding: WorkflowTargetBinding): TargetType | undefined {
  if (binding.targetType === 'kubernetes') return KUBERNETES_TARGET_TYPE;
  if (binding.targetType === 'vm') return VIRTUAL_MACHINE_TARGET_TYPE;
  return undefined;
}

function promptReferenceLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
}

export function workflowTargetPromptReference(targetName: string): string {
  return `@cluster[${promptReferenceLabel(targetName)}]`;
}

function contentReferencesTarget(content: string, targetName: string): boolean {
  return content.toLocaleLowerCase().includes(workflowTargetPromptReference(targetName).toLocaleLowerCase());
}

async function listWorkflowTargets(workspaceId: string, targetType?: TargetType): Promise<TargetSummary[]> {
  const targets: TargetSummary[] = [];
  let cursor: { signature: string; createdAt: string; targetId: string } | null = null;
  do {
    const page = await repo.listTargets(workspaceId, { limit: 100, cursor, targetType, signature: '' });
    targets.push(...page.items);
    cursor = page.nextCursor
      ? decodeCursor<{ signature: string; createdAt: string; targetId: string }>(page.nextCursor, '')
      : null;
  } while (cursor);
  return targets;
}

export function workflowTargetBinding(
  workflow: WorkflowDefinitionForAccess
): WorkflowTargetBinding | undefined {
  return workflow.steps.find((step) => (
    step.targetBinding?.type === 'selected_target' || step.targetBinding?.type === 'selected_cluster'
  ))?.targetBinding;
}

export async function resolveWorkflowTarget(params: {
  workspaceId: string;
  workflow: WorkflowDefinitionForAccess;
  inputs: Record<string, unknown>;
  content?: string;
  targetId?: string;
  targetType?: string;
}): Promise<TargetSummary | undefined> {
  const binding = workflowTargetBinding(params.workflow);
  if (!binding && !params.targetId && !params.targetType) return undefined;

  const inputName = binding?.inputName || 'targetId';
  const inputTargetId = typeof params.inputs[inputName] === 'string'
    ? params.inputs[inputName].trim()
    : '';
  const targetId = params.targetId?.trim() || inputTargetId;
  if (params.targetId && inputTargetId && params.targetId !== inputTargetId) {
    throw new WorkflowTargetResolutionError(
      'WORKFLOW_TARGET_MISMATCH',
      'The workflow target does not match the selected workflow input.'
    );
  }

  const expectedTargetType = binding ? bindingTargetType(binding) : undefined;
  let target: TargetSummary | null | undefined;
  if (targetId) {
    target = await repo.getTarget(params.workspaceId, targetId);
  } else if (binding && params.content?.trim()) {
    const matches = (await listWorkflowTargets(params.workspaceId, expectedTargetType))
      .filter((candidate) => contentReferencesTarget(params.content!, candidate.name));
    if (matches.length > 1) {
      throw new WorkflowTargetResolutionError(
        'WORKFLOW_TARGET_AMBIGUOUS',
        'The control message references more than one matching Kubernetes cluster. Mention exactly one cluster.'
      );
    }
    target = matches[0];
  }
  if (!targetId && !target) {
    throw new WorkflowTargetResolutionError(
      'WORKFLOW_TARGET_MENTION_REQUIRED',
      `Mention one Kubernetes cluster in the control message, for example ${workflowTargetPromptReference('Development Cluster')}.`
    );
  }
  if (!target) {
    throw new WorkflowTargetResolutionError(
      'WORKFLOW_TARGET_NOT_FOUND',
      'The selected target does not exist in this workspace.'
    );
  }
  if (binding && params.content?.trim() && !contentReferencesTarget(params.content, target.name)) {
    throw new WorkflowTargetResolutionError(
      'WORKFLOW_TARGET_MENTION_MISMATCH',
      `The control message must include ${workflowTargetPromptReference(target.name)} so the selected cluster is explicit.`
    );
  }
  const requestedTargetType = params.targetType && isTargetType(params.targetType)
    ? params.targetType
    : undefined;
  if (params.targetType && !requestedTargetType) {
    throw new WorkflowTargetResolutionError(
      'WORKFLOW_TARGET_TYPE_INVALID',
      'The selected workflow target type is not supported.'
    );
  }
  if ((expectedTargetType && target.targetType !== expectedTargetType)
    || (requestedTargetType && target.targetType !== requestedTargetType)) {
    throw new WorkflowTargetResolutionError(
      'WORKFLOW_TARGET_TYPE_MISMATCH',
      'The selected target type does not match this workflow step.'
    );
  }
  if (target.status === 'offline' || target.status === 'unknown') {
    throw new WorkflowTargetResolutionError(
      'WORKFLOW_TARGET_NOT_READY',
      `The selected target is ${target.status} and cannot run this workflow.`
    );
  }
  return target;
}
