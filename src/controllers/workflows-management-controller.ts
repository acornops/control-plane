import { NextFunction, Response } from 'express';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  createWorkflowDefinition,
  createWorkflowMcpServer,
  deleteWorkflowDefinition,
  deleteWorkflowMcpServer,
  getWorkflowDefinition,
  getWorkflowOptionsCatalog,
  listWorkflowMcpServerTools,
  listWorkflowMcpServers,
  testWorkflowMcpServerConnection,
  updateWorkflowDefinitionScope,
  updateWorkflowMcpServer
} from '../store/repository-workflows.js';
import type {
  WorkflowDefinitionForAccess,
  WorkflowStepDefinition
} from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';
import {
  numberValue,
  stringList,
  workflowCapabilityMode,
  workflowCategory,
  workflowInputs,
  workflowOutputArtifacts,
  workflowStatus,
  workflowSteps
} from './workflows-management-parsers.js';

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function requireWorkflowWorkspaceId(req: AuthenticatedRequest, res: Response): string | null {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    res.status(400).json({
      error: {
        code: 'WORKFLOW_WORKSPACE_REQUIRED',
        message: 'workspaceId is required for workspace-scoped workflow routes.',
        retryable: false
      }
    });
    return null;
  }
  return workspaceId;
}

function collectWorkflowReferenceErrors(workspaceId: string, steps: WorkflowStepDefinition[]): string[] {
  const options = getWorkflowOptionsCatalog(workspaceId);
  const knownTools = new Set(options.mcpTools.map((option) => option.value));
  const errors: string[] = [];
  for (const step of steps) {
    for (const tool of step.allowedTools) {
      if (!knownTools.has(tool)) errors.push(`Unknown MCP tool: ${tool}`);
    }
  }
  return errors;
}

function collectWorkflowScopeReferenceErrors(workspaceId: string, mcpServers: string[], skills: string[]): string[] {
  const options = getWorkflowOptionsCatalog(workspaceId);
  const knownServers = new Set(options.mcpServers.map((option) => option.value));
  const knownSkills = new Set(options.skills.map((option) => option.value));
  const errors: string[] = [];
  for (const server of mcpServers) {
    if (!knownServers.has(server)) errors.push(`Unknown MCP server: ${server}`);
  }
  for (const skill of skills) {
    if (!knownSkills.has(skill)) errors.push(`Unknown skill: ${skill}`);
  }
  return errors;
}

function requestWorkflowScopeUpdate(req: AuthenticatedRequest, workflow: WorkflowDefinitionForAccess) {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const policyInput = body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
    ? body.policy as Record<string, unknown>
    : {};
  const mode = workflowCapabilityMode(policyInput.mode);
  const approvalRequirements = stringList(policyInput.approvalRequirements);
  const maxRuntimeSeconds = numberValue(policyInput.maxRuntimeSeconds);
  const retentionDays = numberValue(policyInput.retentionDays);
  const category = workflowCategory(body.category);
  const status = workflowStatus(body.status);
  const inputs = workflowInputs(body.inputs);
  const tags = stringList(body.tags);
  const enabledMcpServers = stringList(body.enabledMcpServers);
  const enabledSkills = stringList(body.enabledSkills);
  const requiredPermissions = stringList(body.requiredPermissions) as WorkflowDefinitionForAccess['requiredPermissions'] | undefined;
  const stepInputs = Array.isArray(body.steps) ? body.steps : [];
  const knownStepIds = new Set(workflow.steps.map((step) => step.id));
  const steps = stepInputs
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      title: typeof entry.title === 'string' ? entry.title.trim() : undefined,
      requiredInputs: stringList(entry.requiredInputs),
      targetBinding: entry.targetBinding && typeof entry.targetBinding === 'object' && !Array.isArray(entry.targetBinding)
        ? entry.targetBinding as WorkflowStepDefinition['targetBinding']
        : undefined,
      enabledSkills: stringList(entry.enabledSkills),
      allowedMcpServers: stringList(entry.allowedMcpServers),
      allowedTools: stringList(entry.allowedTools),
      contextGrants: stringList(entry.contextGrants),
      approvalRequired: typeof entry.approvalRequired === 'boolean' ? entry.approvalRequired : undefined,
      outputArtifacts: workflowOutputArtifacts(entry.outputArtifacts)
    }));
  const unknownStep = steps.find((step) => !knownStepIds.has(step.id));
  return {
    update: {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      status,
      category,
      tags,
      inputs,
      enabledMcpServers,
      enabledSkills,
      requiredPermissions,
      policy: mode || approvalRequirements || maxRuntimeSeconds || retentionDays
        ? { mode, approvalRequirements, maxRuntimeSeconds, retentionDays }
        : undefined,
      steps,
      starterPrompt: typeof body.starterPrompt === 'string' ? body.starterPrompt : undefined
    },
    unknownStepId: unknownStep?.id
  };
}


function badRequest(res: Response, code: string, message: string, details?: unknown): void {
  res.status(400).json({
    error: {
      code,
      message,
      retryable: false,
      details
    }
  });
}

export async function listWorkflowOptions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    res.status(200).json(getWorkflowOptionsCatalog(workspaceId));
  } catch (err) {
    next(err);
  }
}

export async function createWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_mcp',
      'No permission to create workflows'
    );
    if (!authz) return;

    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const category = workflowCategory(body.category) || 'knowledge-capture';
    const steps = workflowSteps(body.steps);
    if (!name) {
      badRequest(res, 'WORKFLOW_NAME_REQUIRED', 'Workflow name is required.');
      return;
    }
    if (!steps || steps.length === 0) {
      badRequest(res, 'WORKFLOW_STEPS_REQUIRED', 'At least one workflow step is required.');
      return;
    }
    const referenceErrors = collectWorkflowReferenceErrors(workspaceId, steps);
    if (referenceErrors.length > 0) {
      badRequest(res, 'WORKFLOW_OPTION_INVALID', 'Workflow references unknown server-provided options.', referenceErrors);
      return;
    }
    const policyInput = body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
      ? body.policy as Record<string, unknown>
      : {};
    const policyMode = policyInput.mode === 'read_write' ? 'read_write' : 'read_only';
    const enabledMcpServers = stringList(body.enabledMcpServers) || [];
    const enabledSkills = stringList(body.enabledSkills) || [];
    const scopeReferenceErrors = collectWorkflowScopeReferenceErrors(workspaceId, enabledMcpServers, enabledSkills);
    if (scopeReferenceErrors.length > 0) {
      badRequest(res, 'WORKFLOW_OPTION_INVALID', 'Workflow references unknown server-provided options.', scopeReferenceErrors);
      return;
    }
    const workflow = createWorkflowDefinition({
      workspaceId,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      category,
      tags: stringList(body.tags) || [],
      inputs: workflowInputs(body.inputs) || [],
      enabledMcpServers,
      enabledSkills,
      requiredPermissions: (stringList(body.requiredPermissions) as WorkflowDefinitionForAccess['requiredPermissions'] | undefined) || [
        'read_workspace_data',
        policyMode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs'
      ],
      policy: {
        mode: policyMode,
        maxRuntimeSeconds: numberValue(policyInput.maxRuntimeSeconds) || 900,
        retentionDays: numberValue(policyInput.retentionDays) || 90,
        approvalRequirements: stringList(policyInput.approvalRequirements) || []
      },
      steps,
      starterPrompt: typeof body.starterPrompt === 'string' ? body.starterPrompt : undefined,
      createdBy: req.auth.userId
    });

    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'workflow.definition_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow',
      objectId: workflow.id,
      objectName: workflow.name,
      summary: 'Workflow definition created',
      metadata: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        category: workflow.category
      }
    });

    res.status(201).json({ workflow });
  } catch (err) {
    next(err);
  }
}

export async function updateWorkflow(_req: AuthenticatedRequest, res: Response): Promise<void> {
  const req = _req;
  const workflowId = toSingleParam(req.params.workflowId);
  const workspaceId = requireWorkflowWorkspaceId(req, res);
  if (!workspaceId) return;
  const workflow = getWorkflowDefinition(workspaceId, workflowId);
  if (!workflow) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    return;
  }
  const authz = await requireWorkspaceCapability(
    req,
    res,
    workflow.workspaceId,
    'manage_mcp',
    'No permission to edit workflow MCP scope'
  );
  if (!authz) return;

  const { update, unknownStepId } = requestWorkflowScopeUpdate(req, workflow);
  if (unknownStepId) {
    res.status(400).json({
      error: {
        code: 'WORKFLOW_STEP_NOT_FOUND',
        message: `Unknown workflow step: ${unknownStepId}`,
        retryable: false
      }
    });
    return;
  }
  const mergedSteps = workflow.steps.map((step) => {
    const stepUpdate = update.steps?.find((candidate) => candidate.id === step.id);
    return stepUpdate
      ? {
          ...step,
          enabledSkills: stepUpdate.enabledSkills || step.enabledSkills,
          allowedMcpServers: stepUpdate.allowedMcpServers || step.allowedMcpServers,
          allowedTools: stepUpdate.allowedTools || step.allowedTools
        }
      : step;
  });
  const referenceErrors = [
    ...collectWorkflowReferenceErrors(workflow.workspaceId, mergedSteps),
    ...collectWorkflowScopeReferenceErrors(
      workflow.workspaceId,
      update.enabledMcpServers || workflow.enabledMcpServers || [],
      update.enabledSkills || workflow.enabledSkills || []
    )
  ];
  if (referenceErrors.length > 0) {
    badRequest(res, 'WORKFLOW_OPTION_INVALID', 'Workflow references unknown server-provided options.', referenceErrors);
    return;
  }

  const updated = updateWorkflowDefinitionScope(workflow.workspaceId, workflow.id, update);
  if (!updated) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    return;
  }

  await recordWorkspaceAuditEvent({
    workspaceId: workflow.workspaceId,
    category: 'mcp',
    eventType: 'workflow.scope_updated.v1',
    operation: 'write',
    actorUserId: req.auth.userId,
    objectType: 'workflow',
    objectId: updated.id,
    objectName: updated.name,
    summary: 'Workflow MCP scope updated',
    metadata: {
      workflowId: updated.id,
      workflowVersion: updated.version,
      category: updated.category,
      mcpServers: [...new Set(updated.steps.flatMap((step) => step.allowedMcpServers))].sort(),
      tools: [...new Set(updated.steps.flatMap((step) => step.allowedTools))].sort(),
      contextGrants: [...new Set(updated.steps.flatMap((step) => step.contextGrants))].sort(),
      approvalRequirements: updated.policy.approvalRequirements
    }
  });

  res.status(200).json({ workflow: updated });
}

export async function deleteWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workflowId = toSingleParam(req.params.workflowId);
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_mcp',
      'No permission to delete workflows'
    );
    if (!authz) return;
    const result = deleteWorkflowDefinition(workspaceId, workflowId);
    if (result === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    if (result === 'system') {
      res.status(409).json({ error: { code: 'SYSTEM_WORKFLOW_IMMUTABLE', message: 'System workflow templates cannot be deleted.', retryable: false } });
      return;
    }
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'workflow.definition_deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow',
      objectId: workflowId,
      summary: 'Workflow definition deleted',
      metadata: { workflowId }
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function listWorkflowMcpServersForWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    res.status(200).json({ items: listWorkflowMcpServers(workspaceId) });
  } catch (err) {
    next(err);
  }
}

export async function createWorkflowMcpServerForWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_mcp', 'No permission to manage MCP servers');
    if (!authz) return;
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!name || !url) {
      badRequest(res, 'MCP_SERVER_INVALID', 'MCP server name and URL are required.');
      return;
    }
    const auth = body.auth && typeof body.auth === 'object' && !Array.isArray(body.auth)
      ? body.auth as { type?: 'none' | 'bearer_token' | 'custom_header' }
      : undefined;
    const server = createWorkflowMcpServer(workspaceId, {
      name,
      url,
      enabled: body.enabled !== false,
      auth,
      publicHeaders: body.publicHeaders && typeof body.publicHeaders === 'object' && !Array.isArray(body.publicHeaders)
        ? body.publicHeaders as Record<string, string>
        : undefined,
      createdBy: req.auth.userId
    });
    res.status(201).json(server);
  } catch (err) {
    next(err);
  }
}

export async function updateWorkflowMcpServerForWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const serverId = toSingleParam(req.params.serverId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_mcp', 'No permission to manage MCP servers');
    if (!authz) return;
    const updated = updateWorkflowMcpServer(workspaceId, serverId, req.body || {});
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
      return;
    }
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteWorkflowMcpServerForWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const serverId = toSingleParam(req.params.serverId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_mcp', 'No permission to manage MCP servers');
    if (!authz) return;
    if (!deleteWorkflowMcpServer(workspaceId, serverId)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function testWorkflowMcpServerConnectionForWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const serverId = toSingleParam(req.params.serverId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_mcp', 'No permission to manage MCP servers');
    if (!authz) return;
    const server = testWorkflowMcpServerConnection(workspaceId, serverId);
    if (!server) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
      return;
    }
    res.status(200).json({
      serverId: server.id,
      status: server.status,
      checkedAt: server.lastCheckedAt,
      message: server.status === 'connected' ? 'Connection available.' : 'Server is disabled.'
    });
  } catch (err) {
    next(err);
  }
}

export async function listWorkflowMcpServerToolsForWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const serverId = toSingleParam(req.params.serverId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const tools = listWorkflowMcpServerTools(workspaceId, serverId);
    if (!tools) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } });
      return;
    }
    res.status(200).json({ items: tools });
  } catch (err) {
    next(err);
  }
}
