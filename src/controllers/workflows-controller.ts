import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { emitWorkflowExecutionEvents } from '../services/workflow-execution-events.js';
import { PromptResourceProviderError } from '../services/prompt-resources/index.js';
import {
  getWorkflowCapabilityReadinessReport,
  publicMcpReadinessError
} from '../services/mcp-readiness.js';
import { compileWorkflowScope } from '../services/workflow-scope-compiler.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  getWorkflowSession,
  listWorkflowDefinitions
} from '../store/repository-workflows.js';
import { getCapabilityOptionsCatalog } from '../store/repository-capability-options.js';
import { toSingleParam } from '../utils/params.js';
import {
  containsSearchText,
  makeQuerySignature,
  normalizeSearchQuery,
  pageArray,
  parseBoundedLimit
} from '../utils/pagination.js';
import { mapGatewayError } from './workspaces/common.js';
import { runRequestProvenance } from './run-actor.js';
import {
  publicWorkflowDefinition,
  respondWorkflowAccessError
} from './workflow-public.js';
import {
  externalWorkflowBlocker,
  isExternalIntegrationRequest,
  isExternallyRunnableWorkflow,
  workflowAuditActor
} from './workflow-external-access.js';
import { externalIntegrationOwnsWorkflowSession } from './workflow-execution-access.js';
import {
  isWorkflowClientRequestIdConflict,
  respondToWorkflowMessageRetry,
  workflowClientRequestId,
  workflowMessageRequestFingerprint
} from './workflow-message-idempotency.js';
import {
  compileWorkflowFollowUp,
  compileWorkflowPrompt,
  WorkflowMessageContentError,
  WorkflowPromptValidationError
} from '../services/workflow-prompt.js';
const WORKFLOW_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function requireWorkflowWorkspaceId(req: AuthenticatedRequest, res: Response): string | null {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    res.status(400).json({ error: { code: 'WORKFLOW_WORKSPACE_REQUIRED', message: 'workspaceId is required.', retryable: false } });
  }
  return workspaceId;
}

export { previewWorkflowCapabilities } from './workflow-capability-preview-controller.js';
export { listSessions } from './workflow-sessions-controller.js';

export async function listWorkflows(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, q });
    const definitions = await listWorkflowDefinitions(workspaceId);
    const externallyRunnable = isExternalIntegrationRequest(req)
      ? new Set((await Promise.all(definitions.map(async (workflow) => (
          await isExternallyRunnableWorkflow(workflow, authz) ? workflow.id : null
        )))).filter((id): id is string => Boolean(id)))
      : null;
    const rows = definitions
      .filter((workflow) => !externallyRunnable || externallyRunnable.has(workflow.id))
      .filter((workflow) => containsSearchText([
        workflow.name,
        workflow.description,
        workflow.prompt,
        workflow.status,
        ...workflow.agentIds
      ], q));
    res.status(200).json(pageArray(rows.map(publicWorkflowDefinition), {
      limit: parseBoundedLimit(req.query.limit),
      cursor: req.query.cursor,
      signature
    }));
  } catch (error) {
    next(error);
  }
}

export async function getWorkflow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const workflow = await getWorkflowDefinition(workspaceId, toSingleParam(req.params.workflowId));
    if (!workflow) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    if (isExternalIntegrationRequest(req)) {
      const blocker = await externalWorkflowBlocker(workflow, authz);
      if (blocker) {
        return void res.status(403).json({ error: {
          code: 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION',
          message: blocker,
          retryable: false
        } });
      }
    }
    res.status(200).json({ workflow: publicWorkflowDefinition(workflow) });
  } catch (error) {
    next(error);
  }
}

export async function listWorkflowOptions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json(await getCapabilityOptionsCatalog(workspaceId));
  } catch (error) {
    next(error);
  }
}

export async function createSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const workflow = await getWorkflowDefinition(workspaceId, toSingleParam(req.params.workflowId));
    if (!workflow) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    if (isExternalIntegrationRequest(req)) {
      const blocker = await externalWorkflowBlocker(workflow, authz);
      if (blocker) {
        return void res.status(403).json({ error: {
          code: 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION',
          message: blocker,
          retryable: false
        } });
      }
    }
    const compiled = await compileWorkflowScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      resolutionPhase: 'session_ceiling'
    });
    const session = await createWorkflowSession({
      workflow,
      createdBy: req.auth.userId,
      compiledAccessScope: compiled.scope,
      requestProvenance: runRequestProvenance(req)
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'workflow.session_created.v2',
      operation: 'write',
      ...workflowAuditActor(req),
      objectType: 'workflow_session',
      objectId: session.id,
      objectName: workflow.name,
      summary: 'Workflow session created',
      metadata: {
        workflowId: workflow.id,
        executionMode: workflow.executionMode,
        selectedAgentCount: workflow.agentIds.length
      }
    });
    res.status(201).json({
      session: {
        id: session.id,
        workspaceId: session.workspaceId,
        workflowId: session.workflowId,
        createdBy: session.createdBy,
        launchedAt: session.launchedAt,
        createdAt: session.createdAt,
        workflowSnapshot: publicWorkflowDefinition(session.workflowSnapshot)
      }
    });
  } catch (error) {
    if (error instanceof WorkflowAccessDeniedError) return respondWorkflowAccessError(res, error);
    next(error);
  }
}

export async function postMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await getWorkflowSession(toSingleParam(req.params.sessionId));
    if (!session) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow session not found', retryable: false } });
    if (isExternalIntegrationRequest(req) && !externalIntegrationOwnsWorkflowSession(req, session)) {
      return void res.status(403).json({ error: {
        code: 'EXTERNAL_INTEGRATION_WORKFLOW_SESSION_NOT_OWNED',
        message: 'This Workflow session belongs to another integration origin.',
        retryable: false
      } });
    }
    const authz = await requireWorkspaceDataRead(req, res, session.workspaceId);
    if (!authz) return;
    const currentWorkflow = await getWorkflowDefinition(session.workspaceId, session.workflowId);
    const workflow = session.workflowSnapshot || currentWorkflow;
    if (!workflow) return void res.status(409).json({ error: { code: 'WORKFLOW_DEFINITION_UNAVAILABLE', message: 'Workflow definition is unavailable.', retryable: false } });
    if (isExternalIntegrationRequest(req)) {
      const blocker = currentWorkflow ? await externalWorkflowBlocker(currentWorkflow, authz) : 'External integrations can only run active workflows.';
      if (blocker) {
        return void res.status(403).json({ error: {
          code: 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION',
          message: blocker,
          retryable: false
        } });
      }
    }
    const requiredCapability = session.compiledAccessScope.mode === 'read_write'
      ? 'create_read_write_runs'
      : 'create_read_only_runs';
    if (!(await requireWorkspaceCapability(req, res, session.workspaceId, requiredCapability, 'No permission to create workflow runs'))) return;
    const kind = req.body?.kind;
    if (kind !== 'launch' && kind !== 'follow_up') {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_MESSAGE_KIND_INVALID',
        message: 'kind must be launch or follow_up.',
        retryable: false
      } });
    }
    const clientRequestId = workflowClientRequestId(req, res);
    if (clientRequestId === null) return;
    const allowedFields = kind === 'launch'
      ? new Set(['kind', 'clientRequestId'])
      : new Set(['kind', 'content', 'clientRequestId']);
    const unexpectedFields = Object.keys(req.body || {}).filter((field) => !allowedFields.has(field));
    if (unexpectedFields.length > 0) {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_MESSAGE_FIELDS_INVALID',
        message: `Workflow ${kind} messages contain unsupported fields.`,
        retryable: false,
        details: { fields: unexpectedFields.sort() }
      } });
    }
    if (kind === 'follow_up' && (typeof req.body.content !== 'string' || !req.body.content.trim())) {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_MESSAGE_REQUIRED',
        message: 'content is required for a follow-up.',
        retryable: false
      } });
    }
    const clientRequestFingerprint = clientRequestId
      ? workflowMessageRequestFingerprint(req.body as Record<string, unknown>)
      : '';
    if (clientRequestId && await respondToWorkflowMessageRetry(
      res,
      session,
      clientRequestId,
      clientRequestFingerprint
    )) return;
    if (kind === 'launch' && session.launchedAt) {
      return void res.status(409).json({ error: {
        code: 'WORKFLOW_SESSION_ALREADY_LAUNCHED',
        message: 'This workflow session has already been launched.',
        retryable: false
      } });
    }
    if (kind === 'follow_up' && !session.launchedAt) {
      return void res.status(409).json({ error: {
        code: 'WORKFLOW_SESSION_NOT_LAUNCHED',
        message: 'Launch this workflow session before sending a follow-up.',
        retryable: false
      } });
    }
    const messageId = randomUUID();
    const resolution = kind === 'launch'
      ? await compileWorkflowPrompt({
          workflow,
          actorUserId: req.auth.userId,
          workflowSessionId: session.id,
          initiatingMessageId: messageId
        })
      : await compileWorkflowFollowUp({
          workflow,
          content: typeof req.body?.content === 'string' ? req.body.content : '',
          actorUserId: req.auth.userId,
          workflowSessionId: session.id,
          initiatingMessageId: messageId
        });
    const content = resolution.content;
    const compiled = await compileWorkflowScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      resourceBindings: resolution.bindings,
      promptDigest: resolution.promptDigest,
      bindingDigest: resolution.bindingDigest
    });
    const mcpReadiness = await getWorkflowCapabilityReadinessReport(
      session.workspaceId,
      compiled.scope,
      { principal: compiled.scope.principal }
    );
    if (mcpReadiness.errors.length > 0) {
      await recordWorkspaceAuditEvent({
        workspaceId: session.workspaceId, category: 'run', eventType: 'workflow.launch_blocked.v1', operation: 'read',
        ...workflowAuditActor(req), objectType: 'workflow', objectId: workflow.id, objectName: workflow.name,
        summary: 'Workflow launch blocked', metadata: {
          workflowId: workflow.id,
          reasonCodes: mcpReadiness.failures.length > 0
            ? [...new Set(mcpReadiness.failures.map((failure) => failure.code))]
            : ['MCP_CONNECTION_UNAVAILABLE']
        }
      });
      return void res.status(409).json({
        error: publicMcpReadinessError(mcpReadiness)
      });
    }
    const llmSettings = await resolveWorkspaceLlmSettings(session.workspaceId);
    if (!llmSettings.allowedProviders.includes(llmSettings.provider)) return void res.status(400).json({ error: { code: 'PROVIDER_NOT_ALLOWED', message: 'Workspace AI provider is not enabled', retryable: false } });
    if (!llmSettings.allowedModels.includes(llmSettings.model) || !isModelAllowedForProvider(llmSettings.provider, llmSettings.model, llmSettings.allowedProviderModels)) {
      return void res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not allowed', retryable: false } });
    }
    if (!llmSettings.credentialConfigured) return void res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Configure an AI provider credential before starting a workflow run.', retryable: false } });
    const created = await createWorkflowExecution({
      workflow,
      session: { ...session, compiledAccessScope: compiled.scope },
      compiledAccessScope: compiled.scope,
      requestProvenance: runRequestProvenance(req),
      messageId,
      content,
      clientRequestId: clientRequestId || undefined,
      clientRequestFingerprint: clientRequestFingerprint || undefined,
      promptDigest: resolution.promptDigest,
      bindingDigest: resolution.bindingDigest,
      resourceBindings: resolution.bindings,
      resolvedAt: resolution.resolvedAt,
      specialistSnapshot: compiled.specialistAgent,
      llmProvider: llmSettings.provider,
      llmModel: llmSettings.model,
      llmReasoningSummaryMode: llmSettings.reasoning.summary_mode,
      llmReasoningEffort: llmSettings.reasoning.effort,
      markSessionLaunched: kind === 'launch'
    });
    emitWorkflowExecutionEvents(created.execution.id, created.initialEvents);
    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'run',
      eventType: 'workflow.run_created.v2',
      operation: 'write',
      ...workflowAuditActor(req),
      objectType: 'workflow_run',
      objectId: created.run.id,
      objectName: workflow.name,
      summary: 'Workflow run created',
      metadata: {
        workflowId: workflow.id,
        executionMode: workflow.executionMode,
        selectedAgentCount: workflow.agentIds.length,
        promptDigest: resolution.promptDigest,
        bindingDigest: resolution.bindingDigest,
        resourceBindingCount: resolution.bindings.length,
        semanticCapabilityIds: compiled.scope.semanticCapabilityIds
      }
    });
    res.status(202).json({
      message_id: created.message.id,
      run_id: created.run.id,
      executionId: created.execution.id,
      status: created.run.status
    });
  } catch (error) {
    if (isWorkflowClientRequestIdConflict(error)) {
      const session = await getWorkflowSession(toSingleParam(req.params.sessionId));
      const clientRequestId = typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId.trim() : '';
      const clientRequestFingerprint = clientRequestId
        ? workflowMessageRequestFingerprint(req.body as Record<string, unknown>)
        : '';
      if (session && clientRequestId && await respondToWorkflowMessageRetry(
        res,
        session,
        clientRequestId,
        clientRequestFingerprint
      )) return;
    }
    if (error instanceof WorkflowAccessDeniedError) return respondWorkflowAccessError(res, error);
    if (error instanceof WorkflowMessageContentError) {
      return void res.status(400).json({ error: {
        code: error.code,
        message: error.message,
        retryable: false
      } });
    }
    if (error instanceof WorkflowPromptValidationError) {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_PROMPT_INVALID',
        message: error.message,
        retryable: false,
        details: { errors: error.errors }
      } });
    }
    if (error instanceof Error && error.name === 'WORKFLOW_SESSION_ALREADY_LAUNCHED') {
      const session = await getWorkflowSession(toSingleParam(req.params.sessionId));
      const clientRequestId = typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId.trim() : '';
      const clientRequestFingerprint = clientRequestId
        ? workflowMessageRequestFingerprint(req.body as Record<string, unknown>)
        : '';
      if (session && clientRequestId && await respondToWorkflowMessageRetry(
        res,
        session,
        clientRequestId,
        clientRequestFingerprint
      )) return;
      return void res.status(409).json({ error: {
        code: 'WORKFLOW_SESSION_ALREADY_LAUNCHED',
        message: error.message,
        retryable: false
      } });
    }
    if (error instanceof PromptResourceProviderError) {
      return void res.status(409).json({ error: { code: error.code, message: error.message, retryable: error.retryable } });
    }
    if (error instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(error, { upstreamMessage: WORKFLOW_GATEWAY_UPSTREAM_MESSAGE });
      return void res.status(mapped.status).json(mapped.body);
    }
    next(error);
  }
}

export { createWorkflow, deleteWorkflow, duplicateWorkflow, updateWorkflow } from './workflows-management-controller.js';
