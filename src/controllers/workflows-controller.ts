import { NextFunction, Response } from 'express';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { dispatchWorkflowRunToExecutionEngine } from '../services/execution-engine-client.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { compileWorkflowAccessScope, WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import {
  appendWorkflowRunEvents,
  createWorkflowDefinition,
  createWorkflowMcpServer,
  createWorkflowRun,
  createWorkflowSession,
  createWorkflowUserMessage,
  deleteWorkflowDefinition,
  deleteWorkflowMcpServer,
  getWorkflowDefinition,
  getWorkflowOptionsCatalog,
  getWorkflowRun,
  getWorkflowSession,
  listWorkflowMcpServers,
  listWorkflowMcpServerTools,
  listWorkflowDefinitions,
  listWorkflowRunsForSession,
  listWorkflowSessions,
  testWorkflowMcpServerConnection,
  updateWorkflowDefinitionScope,
  updateWorkflowMcpServer,
  updateWorkflowRun
} from '../store/repository-workflows.js';
import type {
  WorkflowCapabilityMode,
  WorkflowCategory,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
  WorkflowStepDefinition
} from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

const WORKFLOW_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';
const WORKFLOW_CATEGORIES: WorkflowCategory[] = [
  'cluster-triage',
  'git-operations',
  'workspace-audit',
  'knowledge-capture',
  'release-operations',
  'incident-review',
  'security-review'
];

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

function requestInputs(req: AuthenticatedRequest): Record<string, unknown> {
  return req.body.inputs && typeof req.body.inputs === 'object' && !Array.isArray(req.body.inputs)
    ? req.body.inputs as Record<string, unknown>
    : {};
}

function requestContent(req: AuthenticatedRequest): string {
  return typeof req.body.content === 'string' ? req.body.content.trim() : '';
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function workflowCategory(value: unknown): WorkflowCategory | undefined {
  return typeof value === 'string' && WORKFLOW_CATEGORIES.includes(value as WorkflowCategory)
    ? value as WorkflowCategory
    : undefined;
}

function workflowStatus(value: unknown): WorkflowDefinitionForAccess['status'] | undefined {
  return value === 'active' || value === 'draft' || value === 'paused' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function workflowInputs(value: unknown): WorkflowInputDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      label: typeof entry.label === 'string' ? entry.label.trim() : '',
      type: typeof entry.type === 'string' ? entry.type as WorkflowInputDefinition['type'] : 'text',
      required: entry.required !== false,
      optionSource: typeof entry.optionSource === 'string' ? entry.optionSource : undefined
    }))
    .filter((entry) => entry.name && entry.label);
}

function workflowOutputArtifacts(value: unknown): WorkflowStepDefinition['outputArtifacts'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id.trim() : '',
      type: typeof entry.type === 'string' ? entry.type.trim() : 'markdown',
      title: typeof entry.title === 'string' ? entry.title.trim() : '',
      required: entry.required === true
    }))
    .filter((entry) => entry.id && entry.title);
}

function workflowSteps(value: unknown): WorkflowStepDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const targetBinding = entry.targetBinding && typeof entry.targetBinding === 'object' && !Array.isArray(entry.targetBinding)
        ? entry.targetBinding as WorkflowStepDefinition['targetBinding']
        : undefined;
      return {
        id: typeof entry.id === 'string' ? entry.id.trim() : '',
        title: typeof entry.title === 'string' ? entry.title.trim() : '',
        requiredInputs: stringList(entry.requiredInputs) || [],
        targetBinding,
        enabledSkills: stringList(entry.enabledSkills) || [],
        allowedMcpServers: stringList(entry.allowedMcpServers) || [],
        allowedTools: stringList(entry.allowedTools) || [],
        contextGrants: stringList(entry.contextGrants) || [],
        approvalRequired: entry.approvalRequired === true,
        outputArtifacts: workflowOutputArtifacts(entry.outputArtifacts)
      };
    })
    .filter((entry) => entry.id && entry.title);
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
  const mode: WorkflowCapabilityMode | undefined = policyInput.mode === 'read_only' || policyInput.mode === 'read_write'
    ? policyInput.mode
    : undefined;
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

function enqueueWorkflowRunDispatch(runId: string): void {
  queueMicrotask(async () => {
    const run = getWorkflowRun(runId);
    if (!run) return;
    try {
      updateWorkflowRun(run.id, { status: 'dispatching' });
      await dispatchWorkflowRunToExecutionEngine(run);
      updateWorkflowRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown dispatch failure';
      updateWorkflowRun(run.id, {
        status: 'failed',
        errorCode: 'DISPATCH_FAILED',
        errorMessage: message,
        endedAt: new Date().toISOString()
      });
      appendWorkflowRunEvents(run.id, [
        {
          schema_version: 1,
          run_id: run.id,
          seq: 1,
          ts: new Date().toISOString(),
          type: 'run_failed',
          payload: {
            code: 'DISPATCH_FAILED',
            message,
            retryable: true
          }
        }
      ]);
    }
  });
}

export async function listWorkflows(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    res.status(200).json({ items: listWorkflowDefinitions(workspaceId) });
  } catch (err) {
    next(err);
  }
}

export async function getWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workflowId = toSingleParam(req.params.workflowId);
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const workflow = getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, workflow.workspaceId);
    if (!authz) return;
    res.status(200).json({ workflow });
  } catch (err) {
    next(err);
  }
}

export async function createSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workflowId = toSingleParam(req.params.workflowId);
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const workflow = getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, workflow.workspaceId);
    if (!authz) return;

    const approvedContextGrants = Array.isArray(req.body.approvedContextGrants)
      ? req.body.approvedContextGrants.filter((grant: unknown): grant is string => typeof grant === 'string')
      : [];

    let compiledAccessScope;
    try {
      compiledAccessScope = compileWorkflowAccessScope({
        workflow,
        actor: {
          userId: req.auth.userId,
          role: authz.role,
          permissions: authz.permissions
        },
        approvedContextGrants
      });
    } catch (err) {
      if (err instanceof WorkflowAccessDeniedError) {
        res.status(403).json({
          error: {
            code: err.code,
            message: err.message,
            retryable: false,
            details: {
              missingPermissions: err.missingPermissions,
              missingContextGrants: err.missingContextGrants
            }
          }
        });
        return;
      }
      throw err;
    }

    const session = createWorkflowSession({
      workflow,
      createdBy: req.auth.userId,
      compiledAccessScope
    });

    await recordWorkspaceAuditEvent({
      workspaceId: workflow.workspaceId,
      category: 'run',
      eventType: 'workflow.session_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow_session',
      objectId: session.id,
      objectName: workflow.name,
      summary: 'Workflow session created',
      metadata: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        mode: compiledAccessScope.mode,
        tools: compiledAccessScope.tools,
        contextGrants: compiledAccessScope.contextGrants
      }
    });

    res.status(201).json({ session, compiledAccessScope });
  } catch (err) {
    next(err);
  }
}

export async function listSessions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workflowId = toSingleParam(req.params.workflowId);
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const workflow = getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, workflow.workspaceId);
    if (!authz) return;
    res.status(200).json({
      items: listWorkflowSessions(workflowId).map((session) => ({
        ...session,
        runs: listWorkflowRunsForSession(session.id)
      }))
    });
  } catch (err) {
    next(err);
  }
}

export async function postMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const session = getWorkflowSession(sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow session not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, session.workspaceId);
    if (!authz) return;

    const requiredCapability = session.compiledAccessScope.mode === 'read_write'
      ? 'create_read_write_runs'
      : 'create_read_only_runs';
    const runAuthz = await requireWorkspaceCapability(
      req,
      res,
      session.workspaceId,
      requiredCapability,
      'No permission to create workflow runs'
    );
    if (!runAuthz) return;

    const content = requestContent(req);
    if (!content) {
      res.status(400).json({ error: { code: 'WORKFLOW_MESSAGE_REQUIRED', message: 'content is required.', retryable: false } });
      return;
    }

    const llmSettings = await resolveWorkspaceLlmSettings(session.workspaceId);
    if (!llmSettings.allowedProviders.includes(llmSettings.provider)) {
      res.status(400).json({ error: { code: 'PROVIDER_NOT_ALLOWED', message: 'Workspace AI provider is not enabled', retryable: false } });
      return;
    }
    if (!llmSettings.allowedModels.includes(llmSettings.model)) {
      res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not allowed', retryable: false } });
      return;
    }
    if (!isModelAllowedForProvider(llmSettings.provider, llmSettings.model, llmSettings.allowedModels)) {
      res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not available for the selected provider', retryable: false } });
      return;
    }
    if (!llmSettings.credentialConfigured) {
      res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Configure an AI provider API key in AI Settings before starting a workflow run.', retryable: false } });
      return;
    }

    const message = createWorkflowUserMessage({
      session,
      content,
      inputs: requestInputs(req)
    });
    const firstStep = getWorkflowDefinition(session.workspaceId, session.workflowId)?.steps[0];
    const run = createWorkflowRun({
      session,
      message,
      workflowStepId: firstStep?.id,
      llmProvider: llmSettings.provider,
      llmModel: llmSettings.model,
      llmReasoningSummaryMode: llmSettings.reasoning.summary_mode,
      llmReasoningEffort: llmSettings.reasoning.effort
    });

    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'run',
      eventType: 'workflow.run_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow_run',
      objectId: run.id,
      objectName: session.workflowId,
      summary: 'Workflow run created',
      metadata: {
        workflowId: session.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: session.id,
        workflowStepId: run.workflowStepId,
        mode: session.compiledAccessScope.mode,
        tools: session.compiledAccessScope.tools,
        contextGrants: session.compiledAccessScope.contextGrants
      }
    });

    enqueueWorkflowRunDispatch(run.id);

    res.status(202).json({
      message_id: message.id,
      run_id: run.id,
      workflow_run_id: run.workflowRunId,
      status: run.status,
      compiledAccessScope: session.compiledAccessScope
    });
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: WORKFLOW_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export {
  createWorkflow,
  createWorkflowMcpServerForWorkspace,
  deleteWorkflow,
  deleteWorkflowMcpServerForWorkspace,
  listWorkflowMcpServersForWorkspace,
  listWorkflowMcpServerToolsForWorkspace,
  listWorkflowOptions,
  testWorkflowMcpServerConnectionForWorkspace,
  updateWorkflow,
  updateWorkflowMcpServerForWorkspace
} from './workflows-management-controller.js';
