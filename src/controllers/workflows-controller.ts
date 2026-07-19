import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { computeWorkflowReadiness } from '../services/automation-readiness.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { compileWorkflowAccessScope, compileWorkflowSessionCeiling, WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { resolveWorkflowTarget, WorkflowTargetResolutionError } from '../services/workflow-target-resolution.js';
import {
  getWorkflowCapabilityReadinessReport,
  publicMcpReadinessError
} from '../services/workflow-readiness.js';
import { resolveWorkflowRepositoryScope, validateWorkflowInputs, WorkflowInputValidationError } from '../services/workflow-input-validation.js';
import { resolveEffectiveWorkflowCapabilityIds } from '../services/workflow-capability-policy.js';
import { narrowWorkflowScopeToTargetTools } from '../services/workflow-capability-preview.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { getAgentDefinition } from '../store/repository-agents.js';
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
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor
} from '../types/workflows.js';
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
  publicWorkflowDefinition
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

function requestInputs(req: AuthenticatedRequest): Record<string, unknown> {
  return req.body.inputs && typeof req.body.inputs === 'object' && !Array.isArray(req.body.inputs)
    ? req.body.inputs as Record<string, unknown>
    : {};
}

function approvedContextGrants(req: AuthenticatedRequest): string[] {
  return Array.isArray(req.body.approvedContextGrants)
    ? req.body.approvedContextGrants.filter((value: unknown): value is string => typeof value === 'string')
    : [];
}

function accessError(res: Response, error: WorkflowAccessDeniedError): void {
  res.status(error.code === 'WORKFLOW_PERMISSION_DENIED' ? 403 : 409).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: false,
      details: {
        missingPermissions: error.missingPermissions,
        missingContextGrants: error.missingContextGrants
      }
    }
  });
}

async function compileScope(input: {
  workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinition>>>;
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
  exactTargets?: CompiledWorkflowAccessScope['exactTargets'];
  exactRepository?: CompiledWorkflowAccessScope['exactRepository'];
  resolutionPhase?: 'session_ceiling' | 'run_exact';
}): Promise<{
  scope: CompiledWorkflowAccessScope;
  entryAgent: NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>>;
  mappings: CapabilityRoutingMapping[];
}> {
  const readiness = await computeWorkflowReadiness(input.workflow);
  if (readiness.status !== 'ready') {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE',
      readiness.reasons.slice(0, 4).join(' ') || 'Selected workflow Agents are not ready.'
    );
  }
  const entryAgent = await getAgentDefinition(input.workflow.workspaceId, input.workflow.entryAgentId);
  if (!entryAgent) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_AGENT_SCOPE_DENIED',
      'Workflow routing for the selected Agents is unavailable.'
    );
  }
  const selectedAgents = (await Promise.all(input.workflow.agentIds.map((agentId) => (
    getAgentDefinition(input.workflow.workspaceId, agentId)
  )))).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
  if (input.resolutionPhase === 'session_ceiling') {
    return {
      entryAgent,
      mappings: [],
      scope: compileWorkflowSessionCeiling({
        workflow: input.workflow,
        entryAgent,
        selectedAgents,
        actor: input.actor,
        approvedContextGrants: input.approvedContextGrants
      })
    };
  }
  const effectiveCapabilityIds = resolveEffectiveWorkflowCapabilityIds(input.workflow.capabilityPolicy, selectedAgents);
  const mappings = await listCapabilityRoutingMappings(input.workflow.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: effectiveCapabilityIds
  });
  return {
    entryAgent,
    mappings,
    scope: compileWorkflowAccessScope({
      workflow: input.workflow,
      entryAgent,
      selectedAgents,
      mappings,
      actor: input.actor,
      approvedContextGrants: input.approvedContextGrants,
      exactTargets: input.exactTargets,
      exactRepository: input.exactRepository
    })
  };
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
    const compiled = await compileScope({
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
    if (error instanceof WorkflowAccessDeniedError) return accessError(res, error);
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
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content) return void res.status(400).json({ error: { code: 'WORKFLOW_MESSAGE_REQUIRED', message: 'content is required.', retryable: false } });
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
    const exactTargets = target ? [{ id: target.id, targetType: target.targetType }] : [];
    const exactRepository = resolveWorkflowRepositoryScope(workflow, inputs);
    let compiled = await compileScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      approvedContextGrants: session.compiledAccessScope.contextGrants,
      exactTargets,
      exactRepository
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
      content,
      inputs,
      clientRequestId: typeof req.body.clientRequestId === 'string' ? req.body.clientRequestId : undefined,
      targetId: target?.id,
      targetType: target?.targetType,
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
        exactTargets,
        exactRepository,
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
    if (error instanceof WorkflowAccessDeniedError) return accessError(res, error);
    if (error instanceof WorkflowInputValidationError) {
      return void res.status(400).json({ error: { code: error.code, message: error.message, retryable: false, details: { field: error.field } } });
    }
    if (error instanceof WorkflowTargetResolutionError) {
      return void res.status(error.code === 'WORKFLOW_TARGET_NOT_FOUND' ? 404 : 409).json({ error: { code: error.code, message: error.message, retryable: false } });
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
