import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability } from '../auth/workspace-authorization.js';
import { incrementAutomationDefinitionMutation } from '../metrics.js';
import {
  createWorkflowThroughDefinitionService,
  deleteWorkflowThroughDefinitionService,
  DefinitionValidationError,
  updateWorkflowThroughDefinitionService
} from '../services/automation-definition-service.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  effectiveWorkflowRuntimePolicy,
  manualWorkflowCapabilityPolicy,
  manualWorkflowRequiredPermissions,
  withEffectiveWorkflowRuntimePolicy
} from '../services/workflow-runtime-policy.js';
import {
  getWorkflowDefinition
} from '../store/repository-workflows.js';
import type {
  WorkflowCapabilityPolicy,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
  WorkflowTargetConstraints
} from '../types/workflows.js';
import { TARGET_TYPES, type TargetType } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { publicWorkflowDefinition } from './workflow-public.js';

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function workflowAgentIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((item) => typeof item !== 'string' || item.trim().length === 0)) return null;
  return value.map((item) => (item as string).trim());
}

function capabilityPolicy(value: unknown, fallback?: WorkflowCapabilityPolicy): WorkflowCapabilityPolicy {
  const body = bodyRecord(value);
  const defaults = fallback || manualWorkflowCapabilityPolicy();
  return {
    mode: body.mode === 'read_only'
      ? 'read_only'
      : body.mode === 'read_write'
        ? 'read_write'
        : defaults.mode,
    restrictionMode: body.restrictionMode === 'inherit'
      ? 'inherit'
      : body.restrictionMode === 'restrict'
        ? 'restrict'
        : defaults.restrictionMode,
    semanticCapabilityIds: body.semanticCapabilityIds === undefined
      ? defaults.semanticCapabilityIds
      : strings(body.semanticCapabilityIds),
    contextGrants: body.contextGrants === undefined ? defaults.contextGrants : strings(body.contextGrants),
    ...effectiveWorkflowRuntimePolicy(),
    approvalRequirements: body.approvalRequirements === undefined
      ? defaults.approvalRequirements
      : strings(body.approvalRequirements)
  };
}

function targetConstraints(value: unknown): WorkflowTargetConstraints | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DefinitionValidationError('WORKFLOW_TARGET_CONSTRAINTS_INVALID', 'targetConstraints must be an object or null.');
  }
  const body = value as Record<string, unknown>;
  if ((body.targetTypes !== undefined && !Array.isArray(body.targetTypes))
    || (body.targetIds !== undefined && !Array.isArray(body.targetIds))) {
    throw new DefinitionValidationError('WORKFLOW_TARGET_CONSTRAINTS_INVALID', 'targetTypes and targetIds must be arrays.');
  }
  const rawTargetTypes = strings(body.targetTypes);
  const invalidTargetTypes = rawTargetTypes.filter((item) => !TARGET_TYPES.includes(item as TargetType));
  if (invalidTargetTypes.length) {
    throw new DefinitionValidationError(
      'WORKFLOW_TARGET_TYPE_INVALID',
      'targetConstraints contains unsupported target types.',
      invalidTargetTypes
    );
  }
  const targetTypes = rawTargetTypes as TargetType[];
  const targetIds = strings(body.targetIds);
  return targetTypes.length || targetIds.length ? { targetTypes, targetIds } : undefined;
}

function removedRoutingField(body: Record<string, unknown>): string | null {
  for (const field of ['entryAgentId', 'delegationPolicy', 'executionMode']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return field;
  }
  return null;
}

function inputs(value: unknown): WorkflowInputDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name.trim() : '',
      label: typeof item.label === 'string' ? item.label.trim() : '',
      type: typeof item.type === 'string' ? item.type as WorkflowInputDefinition['type'] : 'text',
      required: item.required !== false,
      optionSource: typeof item.optionSource === 'string' ? item.optionSource : undefined
    }))
    .filter((item) => item.name && item.label);
}

function validationError(res: Response, error: DefinitionValidationError): void {
  if (error.code === 'SYSTEM_WORKFLOW_DEFINITION_IMMUTABLE') {
    incrementAutomationDefinitionMutation('workflow', 'definition', 'rejected');
  }
  res.status(error.code === 'SYSTEM_WORKFLOW_DEFINITION_IMMUTABLE' ? 409 : 400).json({
    error: { code: error.code, message: error.message, retryable: false, details: error.details }
  });
}

async function audit(
  req: AuthenticatedRequest,
  workflow: WorkflowDefinitionForAccess,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: workflow.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorUserId: req.auth.userId,
    objectType: 'workflow',
    objectId: workflow.id,
    objectName: workflow.name,
    summary,
    metadata: {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      executionMode: workflow.executionMode,
      selectedAgentCount: workflow.agentIds.length,
      ...metadata
    }
  });
}

export async function createWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const workspaceId = toSingleParam(req.params.workspaceId);
  try {
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'No permission to create workflows'))) return;
    const body = bodyRecord(req.body);
    const removedField = removedRoutingField(body);
    if (removedField) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_ROUTING_FIELDS_REMOVED',
        message: `${removedField} is no longer accepted. Send agentIds and let AcornOps derive executionMode.`,
        retryable: false
      } });
      return;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const agentIds = workflowAgentIds(body.agentIds);
    if (!name || !prompt || !agentIds) {
      res.status(400).json({ error: { code: 'WORKFLOW_FIELDS_REQUIRED', message: 'name, prompt, and at least one agentId are required.', retryable: false } });
      return;
    }
    const workflow = await createWorkflowThroughDefinitionService({
      workspaceId,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      prompt,
      agentIds,
      targetConstraints: targetConstraints(body.targetConstraints),
      capabilityPolicy: capabilityPolicy(body.capabilityPolicy),
      tags: strings(body.tags),
      inputs: inputs(body.inputs),
      requiredPermissions: (body.requiredPermissions === undefined
        ? manualWorkflowRequiredPermissions()
        : strings(body.requiredPermissions)) as WorkflowDefinitionForAccess['requiredPermissions'],
      createdBy: req.auth.userId,
      status: body.status === 'active' || body.status === 'paused' ? body.status : 'draft'
    });
    await audit(req, workflow, 'workflow.definition_created.v2', 'Workflow V2 definition created');
    incrementAutomationDefinitionMutation('workflow', 'definition', 'success');
    res.status(201).json({ workflow: publicWorkflowDefinition(workflow) });
  } catch (error) {
    if (error instanceof DefinitionValidationError) return validationError(res, error);
    incrementAutomationDefinitionMutation('workflow', 'definition', 'failure');
    next(error);
  }
}

export async function duplicateWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : toSingleParam(req.query.workspaceId as string | string[] | undefined);
  try {
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'No permission to duplicate workflows'))) return;
    const requestBody = bodyRecord(req.body);
    const removedField = removedRoutingField(requestBody);
    if (removedField) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_ROUTING_FIELDS_REMOVED',
        message: `${removedField} is no longer accepted. Send agentIds and let AcornOps derive executionMode.`,
        retryable: false
      } });
      return;
    }
    const source = await getWorkflowDefinition(workspaceId, toSingleParam(req.params.workflowId));
    if (!source) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const workflow = await createWorkflowThroughDefinitionService({
      workspaceId,
      name: typeof req.body?.name === 'string' ? req.body.name : `${source.name} copy`,
      description: source.description,
      prompt: source.prompt,
      agentIds: source.agentIds,
      targetConstraints: source.targetConstraints,
      capabilityPolicy: withEffectiveWorkflowRuntimePolicy(source.capabilityPolicy),
      tags: source.tags,
      inputs: source.inputs,
      requiredPermissions: source.requiredPermissions,
      createdBy: req.auth.userId,
      status: 'draft'
    });
    await audit(req, workflow, 'workflow.definition_duplicated.v2', 'Workflow V2 definition duplicated', { sourceWorkflowId: source.id });
    res.status(201).json({ workflow: publicWorkflowDefinition(workflow) });
  } catch (error) {
    if (error instanceof DefinitionValidationError) return validationError(res, error);
    next(error);
  }
}

export async function updateWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : toSingleParam(req.query.workspaceId as string | string[] | undefined);
  try {
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'No permission to edit workflows'))) return;
    const workflowId = toSingleParam(req.params.workflowId);
    const current = await getWorkflowDefinition(workspaceId, workflowId);
    if (!current) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const body = bodyRecord(req.body);
    const removedField = removedRoutingField(body);
    if (removedField) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_ROUTING_FIELDS_REMOVED',
        message: `${removedField} is no longer accepted. Send agentIds and let AcornOps derive executionMode.`,
        retryable: false
      } });
      return;
    }
    const agentIds = workflowAgentIds(body.agentIds);
    if (!agentIds) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_AGENT_SELECTION_REQUIRED',
        message: 'Every workflow update must include at least one non-empty agentId.',
        retryable: false
      } });
      return;
    }
    const updated = await updateWorkflowThroughDefinitionService(workspaceId, workflowId, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      status: body.status === 'active' || body.status === 'paused' || body.status === 'draft' ? body.status : undefined,
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      agentIds,
      targetConstraints: body.targetConstraints === undefined
        ? undefined
        : body.targetConstraints === null
          ? null
          : targetConstraints(body.targetConstraints),
      capabilityPolicy: body.capabilityPolicy === undefined ? undefined : capabilityPolicy(body.capabilityPolicy, current.capabilityPolicy),
      tags: body.tags === undefined ? undefined : strings(body.tags),
      inputs: body.inputs === undefined ? undefined : inputs(body.inputs),
      requiredPermissions: body.requiredPermissions === undefined ? undefined : strings(body.requiredPermissions) as WorkflowDefinitionForAccess['requiredPermissions']
    });
    if (!updated) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    await audit(req, updated, 'workflow.definition_updated.v2', 'Workflow V2 definition updated');
    res.status(200).json({ workflow: publicWorkflowDefinition(updated) });
  } catch (error) {
    if (error instanceof DefinitionValidationError) return validationError(res, error);
    next(error);
  }
}

export async function deleteWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : toSingleParam(req.query.workspaceId as string | string[] | undefined);
  try {
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'No permission to delete workflows'))) return;
    const workflowId = toSingleParam(req.params.workflowId);
    const current = await getWorkflowDefinition(workspaceId, workflowId);
    if (!current) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const result = await deleteWorkflowThroughDefinitionService(workspaceId, workflowId);
    if (result === 'not_found') return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    await audit(req, current, 'workflow.definition_deleted.v2', 'Workflow V2 definition deleted');
    incrementAutomationDefinitionMutation('workflow', 'definition', 'success');
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
