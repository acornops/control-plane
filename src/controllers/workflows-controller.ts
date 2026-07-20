import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { promptResourceRegistry, PromptResourceProviderError } from '../services/prompt-resources/index.js';
import {
  getWorkflowCapabilityReadinessReport,
  publicMcpReadinessError
} from '../services/workflow-readiness.js';
import { narrowWorkflowScopeToTargetTools } from '../services/workflow-capability-preview.js';
import { compileWorkflowScope } from '../services/workflow-scope-compiler.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { repo } from '../store/repository.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  getWorkflowOptionsCatalog,
  getWorkflowSession,
  listWorkflowDefinitions,
  listWorkflowRunsForSession,
  listWorkflowSessions
} from '../store/repository-workflows.js';
import { isTargetType, type TargetSummary } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import {
  containsSearchText,
  makeQuerySignature,
  normalizeSearchQuery,
  pageArray,
  parseBoundedLimit
} from '../utils/pagination.js';
import { mapGatewayError } from './workspaces/common.js';
import {
  publicCompiledWorkflowScope,
  publicWorkflowDefinition,
  respondWorkflowAccessError
} from './workflow-public.js';

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

function approvedContextGrants(req: AuthenticatedRequest): string[] {
  return Array.isArray(req.body.approvedContextGrants)
    ? req.body.approvedContextGrants.filter((value: unknown): value is string => typeof value === 'string')
    : [];
}

export { previewWorkflowCapabilities } from './workflow-capability-preview-controller.js';

export async function listWorkflows(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, q });
    const rows = (await listWorkflowDefinitions(workspaceId))
      .filter((workflow) => containsSearchText([
        workflow.name,
        workflow.description,
        workflow.prompt,
        workflow.status,
        ...workflow.agentIds,
        ...workflow.capabilityPolicy.semanticCapabilityIds
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
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json({ workflow: publicWorkflowDefinition(workflow) });
  } catch (error) {
    next(error);
  }
}

export async function listWorkflowOptions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json(await getWorkflowOptionsCatalog(workspaceId));
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
    const compiled = await compileWorkflowScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      approvedContextGrants: approvedContextGrants(req),
      resolutionPhase: 'session_ceiling'
    });
    const session = await createWorkflowSession({ workflow, createdBy: req.auth.userId, compiledAccessScope: compiled.scope });
    const publicScope = publicCompiledWorkflowScope(compiled.scope);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'workflow.session_created.v2',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow_session',
      objectId: session.id,
      objectName: workflow.name,
      summary: 'Workflow V2 session created',
      metadata: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        executionMode: workflow.executionMode,
        selectedAgentCount: workflow.agentIds.length
      }
    });
    res.status(201).json({
      session: {
        ...session,
        workflowSnapshot: session.workflowSnapshot ? publicWorkflowDefinition(session.workflowSnapshot) : undefined,
        compiledAccessScope: publicScope
      },
      compiledAccessScope: publicScope
    });
  } catch (error) {
    if (error instanceof WorkflowAccessDeniedError) return respondWorkflowAccessError(res, error);
    next(error);
  }
}

export async function listSessions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireWorkflowWorkspaceId(req, res);
    if (!workspaceId) return;
    const workflowId = toSingleParam(req.params.workflowId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json({
      items: await Promise.all((await listWorkflowSessions(workspaceId, workflowId)).map(async (session) => ({
        ...session,
        workflowSnapshot: session.workflowSnapshot ? publicWorkflowDefinition(session.workflowSnapshot) : undefined,
        compiledAccessScope: publicCompiledWorkflowScope(session.compiledAccessScope),
        runs: (await listWorkflowRunsForSession(session.id)).map((run) => {
          const {
            agentId: _agentId,
            agentVersion: _agentVersion,
            agentSnapshot: _agentSnapshot,
            compiledAccessScope,
            ...publicRun
          } = run;
          return {
            ...publicRun,
            compiledAccessScope: publicCompiledWorkflowScope(compiledAccessScope)
          };
        })
      })))
    });
  } catch (error) {
    next(error);
  }
}

export async function postMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await getWorkflowSession(toSingleParam(req.params.sessionId));
    if (!session) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow session not found', retryable: false } });
    const authz = await requireWorkspaceDataRead(req, res, session.workspaceId);
    if (!authz) return;
    const currentWorkflow = await getWorkflowDefinition(session.workspaceId, session.workflowId);
    const workflow = session.workflowSnapshot || currentWorkflow;
    if (!workflow) return void res.status(409).json({ error: { code: 'WORKFLOW_VERSION_UNAVAILABLE', message: 'Workflow definition is unavailable.', retryable: false } });
    const requiredCapability = workflow.capabilityPolicy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
    if (!(await requireWorkspaceCapability(req, res, session.workspaceId, requiredCapability, 'No permission to create workflow runs'))) return;
    const content = typeof req.body.content === 'string' ? req.body.content : '';
    if (!content.trim()) return void res.status(400).json({ error: { code: 'WORKFLOW_MESSAGE_REQUIRED', message: 'content is required.', retryable: false } });
    const unexpectedFields = Object.keys(req.body || {}).filter((field) => field !== 'content' && field !== 'clientRequestId');
    if (unexpectedFields.length > 0) {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_MESSAGE_FIELDS_INVALID',
        message: 'Workflow messages accept only content and an optional clientRequestId.',
        retryable: false,
        details: { fields: unexpectedFields.sort() }
      } });
    }
    const messageId = randomUUID();
    const resolution = await promptResourceRegistry.resolve(content, {
      workspaceId: session.workspaceId,
      actorUserId: req.auth.userId,
      workflowId: workflow.id,
      workflowSessionId: session.id,
      initiatingMessageId: messageId,
      mode: 'launch',
      requirements: workflow.resourceRequirements || []
    });
    if (resolution.blockers.length > 0) {
      return void res.status(409).json({ error: {
        code: 'WORKFLOW_PROMPT_REFERENCES_BLOCKED',
        message: 'One or more prompt resource references could not be resolved.',
        retryable: resolution.blockers.some((blocker) => blocker.retryable),
        details: { blockers: resolution.blockers, tokens: resolution.tokens }
      } });
    }
    const runtimeProjection = promptResourceRegistry.projectRuntime(resolution.bindings, messageId);
    const projectedTarget = runtimeProjection.targetRoute && typeof runtimeProjection.targetRoute === 'object'
      ? runtimeProjection.targetRoute as Record<string, unknown>
      : undefined;
    const targetRoute = projectedTarget
      && typeof projectedTarget.id === 'string'
      && typeof projectedTarget.targetType === 'string'
      && isTargetType(projectedTarget.targetType)
      ? { id: projectedTarget.id, targetType: projectedTarget.targetType }
      : undefined;
    const target: TargetSummary | undefined = targetRoute
      ? await repo.getTarget(session.workspaceId, targetRoute.id) || undefined
      : undefined;
    if (targetRoute && !target) {
      return void res.status(409).json({ error: { code: 'PROMPT_REFERENCE_NOT_FOUND', message: 'The bound target is no longer available.', retryable: false } });
    }
    let compiled = await compileWorkflowScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      approvedContextGrants: session.compiledAccessScope.contextGrants,
      targetRoute,
      resourceBindings: resolution.bindings,
      promptDigest: resolution.promptDigest,
      bindingDigest: resolution.bindingDigest
    });
    if (target) {
      const resolution = await resolveTargetRunTools({
        workspaceId: session.workspaceId,
        targetId: target.id,
        targetType: target.targetType,
        toolAccessMode: compiled.scope.mode,
        includeNativeTools: false,
        strictMcpResolution: true
      });
      const narrowed = narrowWorkflowScopeToTargetTools({
        scope: compiled.scope,
        mappings: compiled.mappings,
        resolution
      });
      if (compiled.scope.targetToolRefs.length > 0 && narrowed.targetTools.allowedToolRefs.length === 0) {
        await recordWorkspaceAuditEvent({
          workspaceId: session.workspaceId, category: 'run', eventType: 'workflow.launch_blocked.v1', operation: 'read',
          actorUserId: req.auth.userId, objectType: 'workflow', objectId: workflow.id, objectName: workflow.name,
          summary: 'Workflow launch blocked', metadata: { workflowId: workflow.id, reasonCodes: ['WORKFLOW_TARGET_TOOLS_UNAVAILABLE'] }
        });
        return void res.status(409).json({ error: { code: 'WORKFLOW_TARGET_TOOLS_UNAVAILABLE', message: 'The selected target tool catalog is unavailable.', retryable: true } });
      }
      compiled = { ...compiled, scope: narrowed.scope };
    }
    const mcpReadiness = await getWorkflowCapabilityReadinessReport(
      session.workspaceId,
      compiled.scope,
      target,
      { principal: compiled.scope.principal }
    );
    if (mcpReadiness.errors.length > 0) {
      await recordWorkspaceAuditEvent({
        workspaceId: session.workspaceId, category: 'run', eventType: 'workflow.launch_blocked.v1', operation: 'read',
        actorUserId: req.auth.userId, objectType: 'workflow', objectId: workflow.id, objectName: workflow.name,
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
      messageId,
      content,
      clientRequestId: typeof req.body.clientRequestId === 'string' ? req.body.clientRequestId : undefined,
      targetId: targetRoute?.id,
      targetType: targetRoute?.targetType,
      promptDigest: resolution.promptDigest,
      bindingDigest: resolution.bindingDigest,
      resourceBindings: resolution.bindings,
      resolvedAt: resolution.resolvedAt,
      agentSnapshot: compiled.entryAgent as unknown as Record<string, unknown>,
      llmProvider: llmSettings.provider,
      llmModel: llmSettings.model,
      llmReasoningSummaryMode: llmSettings.reasoning.summary_mode,
      llmReasoningEffort: llmSettings.reasoning.effort
    });
    await recordWorkspaceAuditEvent({
      workspaceId: session.workspaceId,
      category: 'run',
      eventType: 'workflow.run_created.v2',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workflow_run',
      objectId: created.run.id,
      objectName: workflow.name,
      summary: 'Workflow V2 run created',
      metadata: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
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
      workflow_run_id: created.run.workflowRunId,
      executionId: created.execution.id,
      status: created.run.status,
      compiledAccessScope: publicCompiledWorkflowScope(compiled.scope)
    });
  } catch (error) {
    if (error instanceof WorkflowAccessDeniedError) return respondWorkflowAccessError(res, error);
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

export {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  updateWorkflow
} from './workflows-management-controller.js';
