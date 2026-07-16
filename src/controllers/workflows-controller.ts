import { NextFunction, Response } from 'express';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { dispatchWorkflowRunToExecutionEngine } from '../services/execution-engine-client.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { compileWorkflowAccessScope, WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { getWorkflowCapabilityReadinessErrors } from '../services/workflow-readiness.js';
import { resolveWorkflowTarget, WorkflowTargetResolutionError } from '../services/workflow-target-resolution.js';
import { validateWorkflowInputs, WorkflowInputValidationError } from '../services/workflow-input-validation.js';
import {
  appendWorkflowRunEvents,
  createWorkflowDefinition,
  createWorkflowMcpServer,
  createWorkflowExecution,
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
import { listAgentDefinitions } from '../store/repository-agents.js';
import type { WorkflowDefinitionForAccess, WorkflowStepDefinition } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';
import { containsSearchText, makeQuerySignature, normalizeSearchQuery, pageArray, parseBoundedLimit } from '../utils/pagination.js';
import { mapGatewayError } from './workspaces/common.js';
import { requestWorkflowScopeUpdate } from './workflow-request-parsers.js';
import {
  externalWorkflowBlocker,
  isExternalIntegrationRequest,
  isExternallyRunnableWorkflow,
  validateApprovedContextGrants,
  workflowAuditActor
} from './workflow-external-access.js';

const WORKFLOW_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';

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


async function collectWorkflowReferenceErrors(workspaceId: string, steps: WorkflowStepDefinition[]): Promise<string[]> {
  const options = await getWorkflowOptionsCatalog(workspaceId);
  const knownTools = new Set(options.mcpTools.map((option) => option.value));
  const knownAgents = new Set(options.agents.map((option) => option.value));
  const errors: string[] = [];
  for (const step of steps) {
    if ((step.agentIds || []).length !== 1) errors.push(`Step ${step.id} must select exactly one Agent.`);
    for (const agent of step.agentIds || []) {
      if (!knownAgents.has(agent)) errors.push(`Unknown agent: ${agent}`);
    }
    for (const tool of step.allowedTools) {
      if (!knownTools.has(tool)) errors.push(`Unknown MCP tool: ${tool}`);
    }
  }
  return errors;
}

async function collectWorkflowScopeReferenceErrors(workspaceId: string, mcpServers: string[], skills: string[]): Promise<string[]> {
  const options = await getWorkflowOptionsCatalog(workspaceId);
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

export async function listWorkflows(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, q });
    const rows = (await listWorkflowDefinitions(workspaceId))
      .filter((workflow) => !isExternalIntegrationRequest(req) || isExternallyRunnableWorkflow(workflow, authz))
      .filter((workflow) => containsSearchText([workflow.name, workflow.description, workflow.category, workflow.status], q));
    res.status(200).json(pageArray(rows, {
      limit: parseBoundedLimit(req.query.limit), cursor: req.query.cursor, signature
    }));
  } catch (err) {
    next(err);
  }
}

export async function getWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workflowId = toSingleParam(req.params.workflowId);
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const workflow = await getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, workflow.workspaceId);
    if (!authz) return;
    if (isExternalIntegrationRequest(req)) {
      const blocker = externalWorkflowBlocker(workflow, authz);
      if (blocker) {
        res.status(403).json({ error: { code: 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION', message: blocker, retryable: false } });
        return;
      }
    }
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
    const workflow = await getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, workflow.workspaceId);
    if (!authz) return;
    if (workflow.status !== 'active') {
      res.status(403).json({ error: { code: 'WORKFLOW_NOT_ACTIVE', message: 'Only active workflows can create new sessions.', retryable: false } });
      return;
    }
    const sessionAuthz = await requireWorkspaceCapability(
      req,
      res,
      workflow.workspaceId,
      'create_sessions',
      'No permission to create workflow sessions'
    );
    if (!sessionAuthz) return;
    if (isExternalIntegrationRequest(req)) {
      const blocker = externalWorkflowBlocker(workflow, sessionAuthz);
      if (blocker) {
        res.status(403).json({ error: { code: 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION', message: blocker, retryable: false } });
        return;
      }
    }

    const approvedContextGrants = Array.isArray(req.body.approvedContextGrants)
      ? req.body.approvedContextGrants
        .filter((grant: unknown): grant is string => typeof grant === 'string')
        .map((grant: string) => grant.trim())
        .filter(Boolean)
      : [];
    const grantValidation = validateApprovedContextGrants(workflow, approvedContextGrants);
    if (grantValidation.extra.length > 0) {
      res.status(400).json({
        error: {
          code: 'WORKFLOW_CONTEXT_GRANT_UNKNOWN',
          message: 'approvedContextGrants includes grants that are not required by this workflow.',
          retryable: false,
          details: { extraContextGrants: grantValidation.extra }
        }
      });
      return;
    }

    let compiledAccessScope;
    try {
      compiledAccessScope = compileWorkflowAccessScope({
        workflow,
        agents: await listAgentDefinitions(workflow.workspaceId),
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

    const readinessErrors = await getWorkflowCapabilityReadinessErrors(workflow.workspaceId, compiledAccessScope);
    if (readinessErrors.length > 0) {
      res.status(409).json({ error: {
        code: 'WORKFLOW_CAPABILITY_NOT_READY', message: readinessErrors[0], retryable: false, details: { readinessErrors }
      } });
      return;
    }

    const session = await createWorkflowSession({
      workflow,
      createdBy: req.auth.userId,
      compiledAccessScope
    });

    await recordWorkspaceAuditEvent({
      workspaceId: workflow.workspaceId,
      category: 'run',
      eventType: 'workflow.session_created.v1',
      operation: 'write',
      ...workflowAuditActor(req),
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
    const workflow = await getWorkflowDefinition(workspaceId, workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, workflow.workspaceId);
    if (!authz) return;
    res.status(200).json({
      items: await Promise.all((await listWorkflowSessions(workspaceId, workflowId)).map(async (session) => ({
        ...session,
        runs: await listWorkflowRunsForSession(session.id)
      })))
    });
  } catch (err) {
    next(err);
  }
}

export async function postMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const session = await getWorkflowSession(sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow session not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, session.workspaceId);
    if (!authz) return;
    const workflow = await getWorkflowDefinition(session.workspaceId, session.workflowId);
    if (!workflow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
      return;
    }
    if (workflow.status !== 'active') {
      res.status(403).json({ error: { code: 'WORKFLOW_NOT_ACTIVE', message: 'Only active workflows can create new runs.', retryable: false } });
      return;
    }
    if (isExternalIntegrationRequest(req)) {
      const blocker = externalWorkflowBlocker(workflow, authz);
      if (blocker) {
        res.status(403).json({ error: { code: 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION', message: blocker, retryable: false } });
        return;
      }
    }

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

    const firstStep = workflow.steps[0];
    if (!firstStep || firstStep.agentIds?.length !== 1) {
      res.status(409).json({ error: { code: 'WORKFLOW_STEP_AGENT_INVALID', message: 'Each executable workflow step must select exactly one active Agent.', retryable: false } });
      return;
    }
    const agent = (await listAgentDefinitions(session.workspaceId, { includeInactive: true }))
      .find((candidate) => candidate.id === firstStep.agentIds![0]);
    if (!agent || agent.status !== 'active') {
      res.status(409).json({ error: { code: 'WORKFLOW_AGENT_NOT_READY', message: 'The selected workflow Agent is not active.', retryable: false } });
      return;
    }
    const inputs = requestInputs(req);
    await validateWorkflowInputs({ workspaceId: session.workspaceId, workflow, inputs, content });
    const target = await resolveWorkflowTarget({
      workspaceId: session.workspaceId,
      workflow,
      inputs,
      content,
      targetId: typeof req.body.targetId === 'string' ? req.body.targetId : undefined,
      targetType: typeof req.body.targetType === 'string' ? req.body.targetType : undefined
    });
    const readinessErrors = await getWorkflowCapabilityReadinessErrors(
      session.workspaceId,
      session.compiledAccessScope,
      target
    );
    if (readinessErrors.length > 0) {
      res.status(409).json({ error: {
        code: 'WORKFLOW_CAPABILITY_NOT_READY', message: readinessErrors[0], retryable: false, details: { readinessErrors }
      } });
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
    if (!isModelAllowedForProvider(llmSettings.provider, llmSettings.model, llmSettings.allowedProviderModels)) {
      res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not available for the selected provider', retryable: false } });
      return;
    }
    if (!llmSettings.credentialConfigured) {
      res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Configure an AI provider API key in AI Settings before starting a workflow run.', retryable: false } });
      return;
    }
    const created = await createWorkflowExecution({
      workflow,
      session,
      content,
      inputs,
      clientRequestId: typeof req.body.clientRequestId === 'string' ? req.body.clientRequestId : undefined,
      targetId: target?.id,
      targetType: target?.targetType,
      agentSnapshot: agent as unknown as Record<string, unknown>,
      llmProvider: llmSettings.provider,
      llmModel: llmSettings.model,
      llmReasoningSummaryMode: llmSettings.reasoning.summary_mode,
      llmReasoningEffort: llmSettings.reasoning.effort
    });
    const { execution, message, run } = created;

    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'run',
      eventType: 'workflow.run_created.v1',
      operation: 'write',
      ...workflowAuditActor(req),
      objectType: 'workflow_run',
      objectId: run.id,
      objectName: session.workflowId,
      summary: 'Workflow run created',
      metadata: {
        workflowId: session.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: session.id,
        workflowStepId: run.workflowStepId,
        targetId: run.targetId || null,
        targetType: run.targetType || null,
        mode: session.compiledAccessScope.mode,
        tools: session.compiledAccessScope.tools,
        contextGrants: session.compiledAccessScope.contextGrants
      }
    });

    res.status(202).json({
      message_id: message.id,
      run_id: run.id,
      workflow_run_id: run.workflowRunId,
      executionId: execution.id,
      status: run.status,
      compiledAccessScope: session.compiledAccessScope
    });
  } catch (err) {
    if (err instanceof WorkflowInputValidationError) {
      res.status(400).json({
        error: { code: err.code, message: err.message, retryable: false, details: { field: err.field } }
      });
      return;
    }
    if (err instanceof WorkflowTargetResolutionError) {
      res.status(err.code === 'WORKFLOW_TARGET_NOT_FOUND' ? 404 : 409).json({
        error: { code: err.code, message: err.message, retryable: false }
      });
      return;
    }
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
export { updateWorkflowMcpToolForWorkspace } from './workflows-mcp-tool-controller.js';
