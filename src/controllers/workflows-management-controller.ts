import type { NextFunction, Response } from 'express';
import { z } from 'zod';
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
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import type { PromptResourceRequirement } from '../types/prompt-resources.js';
import { promptResourceRegistry } from '../services/prompt-resources/index.js';
import { toSingleParam } from '../utils/params.js';
import { publicWorkflowDefinition } from './workflow-public.js';
import {
  parseWorkflowTemplate,
  workflowTemplateResourceCardinalityBlockers
} from '../services/workflow-template.js';

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

const nonEmptyStringSchema = z.string().trim().min(1);
const stringListSchema = z.array(nonEmptyStringSchema);

function workflowAgentIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((item) => typeof item !== 'string' || item.trim().length === 0)) return null;
  return value.map((item) => (item as string).trim());
}

const workflowCapabilityPolicyBodySchema = z.object({
  mode: z.enum(['read_only', 'read_write']).optional(),
  restrictionMode: z.enum(['inherit', 'restrict']).optional(),
  semanticCapabilityIds: stringListSchema.optional(),
  contextGrants: stringListSchema.optional(),
  approvalRequirements: stringListSchema.optional()
}).strict();

const resourceRequirementBodySchema = z.object({
  type: nonEmptyStringSchema,
  minimum: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative(),
  requiredOperations: stringListSchema,
  constraints: z.record(z.unknown()).optional()
}).strict();

function capabilityPolicy(value: unknown, fallback?: WorkflowCapabilityPolicy): WorkflowCapabilityPolicy {
  const parsed = workflowCapabilityPolicyBodySchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new DefinitionValidationError(
      'INVALID_REQUEST',
      parsed.error.issues[0]?.message || 'Invalid workflow capability policy.'
    );
  }
  const body = parsed.data;
  const defaults = fallback || manualWorkflowCapabilityPolicy();
  return {
    mode: body.mode ?? defaults.mode,
    restrictionMode: body.restrictionMode ?? defaults.restrictionMode,
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

function resourceRequirements(value: unknown): PromptResourceRequirement[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new DefinitionValidationError('WORKFLOW_RESOURCE_REQUIREMENTS_INVALID', 'resourceRequirements must be an array.');
  }
  const registered = new Map(promptResourceRegistry.descriptors().map((descriptor) => [descriptor.type, descriptor]));
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new DefinitionValidationError('WORKFLOW_RESOURCE_REQUIREMENTS_INVALID', `Resource requirement ${index + 1} must be an object.`);
    }
    const parsed = resourceRequirementBodySchema.safeParse(item);
    if (!parsed.success) {
      throw new DefinitionValidationError(
        'WORKFLOW_RESOURCE_REQUIREMENTS_INVALID',
        parsed.error.issues[0]?.message || `Resource requirement ${index + 1} is invalid.`
      );
    }
    const body = parsed.data;
    const type = body.type;
    const descriptor = registered.get(type);
    const minimum = body.minimum;
    const maximum = body.maximum;
    if (!descriptor || minimum < 0 || maximum < minimum || maximum > descriptor.maximum) {
      throw new DefinitionValidationError('WORKFLOW_RESOURCE_REQUIREMENTS_INVALID', `Resource requirement ${index + 1} has an unknown type or invalid cardinality.`);
    }
    return {
      type,
      minimum,
      maximum,
      requiredOperations: body.requiredOperations,
      constraints: body.constraints
    };
  });
}

const workflowAuthoringBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  agentIds: z.array(nonEmptyStringSchema).min(1).optional(),
  resourceRequirements: z.array(resourceRequirementBodySchema).optional(),
  capabilityPolicy: workflowCapabilityPolicyBodySchema.optional(),
  tags: stringListSchema.optional(),
  requiredPermissions: stringListSchema.optional(),
  status: z.enum(['active', 'draft', 'paused']).optional()
}).strict();

const workflowUpdateBodySchema = workflowAuthoringBodySchema.extend({
  workspaceId: nonEmptyStringSchema
}).strict();

const workflowDuplicateBodySchema = z.object({
  workspaceId: nonEmptyStringSchema,
  name: z.string().min(1).optional()
}).strict();

const workflowWorkspaceBodySchema = z.object({
  workspaceId: nonEmptyStringSchema
}).strict();

function strictWorkflowBody(
  value: unknown,
  schema: typeof workflowAuthoringBodySchema
    | typeof workflowUpdateBodySchema
    | typeof workflowDuplicateBodySchema
    | typeof workflowWorkspaceBodySchema
): Record<string, unknown> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new DefinitionValidationError('INVALID_REQUEST', result.error.issues[0]?.message || 'Invalid request body.');
  }
  return result.data;
}

function validationError(res: Response, error: DefinitionValidationError): void {
  if (error.code === 'SYSTEM_WORKFLOW_DEFINITION_IMMUTABLE') {
    incrementAutomationDefinitionMutation('workflow', 'definition', 'rejected');
  }
  res.status(error.code === 'SYSTEM_WORKFLOW_DEFINITION_IMMUTABLE' ? 409 : 400).json({
    error: { code: error.code, message: error.message, retryable: false, details: error.details }
  });
}

async function validateAuthoringPrompt(
  workspaceId: string,
  actorUserId: string,
  prompt: string,
  requirements: PromptResourceRequirement[]
): Promise<void> {
  const template = parseWorkflowTemplate(prompt);
  if (template.errors.length > 0) {
    throw new DefinitionValidationError(
      'WORKFLOW_PROMPT_TEMPLATE_INVALID',
      template.errors.map((error) => error.message).slice(0, 3).join(' '),
      template.errors.map((error) => error.code)
    );
  }
  const resolution = await promptResourceRegistry.resolve(prompt, {
    workspaceId,
    actorUserId,
    mode: 'authoring',
    requirements
  }, {
    enforceCardinality: false,
    includeImplicit: false
  });
  if (resolution.blockers.length > 0) {
    throw new DefinitionValidationError(
      'WORKFLOW_PROMPT_REFERENCES_INVALID',
      resolution.blockers.map((blocker) => blocker.message).slice(0, 3).join(' '),
      resolution.blockers.map((blocker) => blocker.code)
    );
  }
  const cardinalityBlockers = workflowTemplateResourceCardinalityBlockers({
    parameters: template.parameters,
    concreteBindings: resolution.bindings,
    requirements
  });
  if (cardinalityBlockers.length > 0) {
    throw new DefinitionValidationError(
      'WORKFLOW_PROMPT_RESOURCE_CARDINALITY_INVALID',
      cardinalityBlockers.map((blocker) => blocker.message).slice(0, 3).join(' '),
      cardinalityBlockers.map((blocker) => blocker.code)
    );
  }
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
    const body = strictWorkflowBody(req.body, workflowAuthoringBodySchema);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const agentIds = workflowAgentIds(body.agentIds);
    if (!name || !prompt || !agentIds) {
      res.status(400).json({ error: { code: 'WORKFLOW_FIELDS_REQUIRED', message: 'name, prompt, and at least one agentId are required.', retryable: false } });
      return;
    }
    const parsedRequirements = resourceRequirements(body.resourceRequirements);
    await validateAuthoringPrompt(workspaceId, req.auth.userId, prompt, parsedRequirements);
    const workflow = await createWorkflowThroughDefinitionService({
      workspaceId,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      prompt,
      agentIds,
      resourceRequirements: parsedRequirements,
      capabilityPolicy: capabilityPolicy(body.capabilityPolicy),
      tags: strings(body.tags),
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
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : '';
  try {
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'No permission to duplicate workflows'))) return;
    const requestBody = strictWorkflowBody(req.body, workflowDuplicateBodySchema);
    const source = await getWorkflowDefinition(workspaceId, toSingleParam(req.params.workflowId));
    if (!source) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const workflow = await createWorkflowThroughDefinitionService({
      workspaceId,
      name: typeof requestBody.name === 'string' ? requestBody.name : `${source.name} copy`,
      description: source.description,
      prompt: source.prompt,
      agentIds: source.agentIds,
      resourceRequirements: source.resourceRequirements,
      capabilityPolicy: withEffectiveWorkflowRuntimePolicy(source.capabilityPolicy),
      tags: source.tags,
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
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : '';
  try {
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'No permission to edit workflows'))) return;
    const workflowId = toSingleParam(req.params.workflowId);
    const current = await getWorkflowDefinition(workspaceId, workflowId);
    if (!current) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const body = strictWorkflowBody(req.body, workflowUpdateBodySchema);
    const agentIds = workflowAgentIds(body.agentIds);
    if (!agentIds) {
      res.status(400).json({ error: {
        code: 'WORKFLOW_AGENT_SELECTION_REQUIRED',
        message: 'Every workflow update must include at least one non-empty agentId.',
        retryable: false
      } });
      return;
    }
    const nextPrompt = typeof body.prompt === 'string' ? body.prompt : current.prompt;
    const nextRequirements = body.resourceRequirements === undefined
      ? current.resourceRequirements
      : resourceRequirements(body.resourceRequirements);
    await validateAuthoringPrompt(workspaceId, req.auth.userId, nextPrompt, nextRequirements);
    const updated = await updateWorkflowThroughDefinitionService(workspaceId, workflowId, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      status: body.status === 'active' || body.status === 'paused' || body.status === 'draft' ? body.status : undefined,
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      agentIds,
      resourceRequirements: body.resourceRequirements === undefined ? undefined : nextRequirements,
      capabilityPolicy: body.capabilityPolicy === undefined ? undefined : capabilityPolicy(body.capabilityPolicy, current.capabilityPolicy),
      tags: body.tags === undefined ? undefined : strings(body.tags),
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
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : '';
  try {
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'No permission to delete workflows'))) return;
    strictWorkflowBody(req.body, workflowWorkspaceBodySchema);
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
