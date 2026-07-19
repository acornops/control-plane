import { repo } from '../store/repository.js';
import { isTargetType, type TargetSummary } from '../types/domain.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';

export class WorkflowTargetResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkflowTargetResolutionError';
  }
}

export async function resolveWorkflowTarget(params: {
  workspaceId: string;
  workflow: WorkflowDefinitionForAccess;
  inputs: Record<string, unknown>;
  content?: string;
  targetId?: string;
  targetType?: string;
}): Promise<TargetSummary | undefined> {
  const constraints = params.workflow.targetConstraints;
  const inputTargetId = typeof params.inputs.targetId === 'string' ? params.inputs.targetId.trim() : '';
  const explicitTargetId = params.targetId?.trim() || inputTargetId;
  if (params.targetId && inputTargetId && params.targetId !== inputTargetId) {
    throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_MISMATCH', 'The requested target does not match the workflow input.');
  }
  const targetId = explicitTargetId || (constraints?.targetIds.length === 1 ? constraints.targetIds[0] : '');
  if (!targetId) {
    if (constraints && (constraints.targetIds.length || constraints.targetTypes.length)) {
      throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_REQUIRED', 'Select one exact target for this workflow run.');
    }
    if (params.targetType) {
      throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_REQUIRED', 'targetType cannot be supplied without an exact targetId.');
    }
    return undefined;
  }
  const target = await repo.getTarget(params.workspaceId, targetId);
  if (!target) {
    throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_NOT_FOUND', 'The selected target does not exist in this workspace.');
  }
  if (params.targetType && (!isTargetType(params.targetType) || target.targetType !== params.targetType)) {
    throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_TYPE_MISMATCH', 'The selected target type does not match the exact target.');
  }
  if (constraints?.targetIds.length && !constraints.targetIds.includes(target.id)) {
    throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_CONSTRAINT_DENIED', 'The selected target is outside the workflow target constraints.');
  }
  if (constraints?.targetTypes.length && !constraints.targetTypes.includes(target.targetType)) {
    throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_TYPE_MISMATCH', 'The selected target type is outside the workflow target constraints.');
  }
  if (target.status === 'offline' || target.status === 'unknown') {
    throw new WorkflowTargetResolutionError('WORKFLOW_TARGET_NOT_READY', `The selected target is ${target.status}.`);
  }
  return target;
}
