import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { logger } from '../logger.js';
import { incrementWorkflowCapabilityPreviewBlocker, observeWorkflowCapabilityPreview } from '../metrics.js';
import { computeWorkflowReadiness } from '../services/automation-readiness.js';
import {
  directWorkflowAttachments,
  narrowWorkflowScopeToTargetTools,
  targetPreviewTools,
  unavailableSelectedTarget,
  workflowRequiresExactTarget,
  workflowTargetCandidates
} from '../services/workflow-capability-preview.js';
import { resolveEffectiveWorkflowCapabilityIds } from '../services/workflow-capability-policy.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { compileWorkflowAccessScope, WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { getWorkflowCapabilityReadinessReport } from '../services/workflow-readiness.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { repo } from '../store/repository.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import type { WorkflowAccessActor, WorkflowCapabilitiesPreview, WorkflowCapabilityPreviewReasonCode, WorkflowCapabilityToolPreview, WorkflowTargetCapabilityCandidate } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';
import { publicCompiledWorkflowScope } from './workflow-public.js';
import { getMcpUserConnection, listAgentMcpServers } from '../services/mcp-registry-client.js';
import { resolveWorkflowRepositoryScope, WorkflowInputValidationError } from '../services/workflow-input-validation.js';

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
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
      details: { missingPermissions: error.missingPermissions, missingContextGrants: error.missingContextGrants }
    }
  });
}

async function compilePreviewScope(input: {
  workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinition>>>;
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
  exactTargets: Array<{ id: string; targetType: 'kubernetes' | 'virtual_machine' }>;
  exactRepository?: import('../types/workflows.js').WorkflowRepositoryScope;
}) {
  const readiness = await computeWorkflowReadiness(input.workflow);
  if (readiness.status !== 'ready') {
    throw new WorkflowAccessDeniedError('WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE', readiness.reasons.slice(0, 4).join(' ') || 'Selected workflow Agents are not ready.');
  }
  const selectedAgents = (await Promise.all(input.workflow.agentIds.map((agentId) => getAgentDefinition(input.workflow.workspaceId, agentId))))
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
  const entryAgent = selectedAgents.find((agent) => agent.id === input.workflow.entryAgentId);
  if (!entryAgent) throw new WorkflowAccessDeniedError('WORKFLOW_AGENT_SCOPE_DENIED', 'Workflow routing for the selected Agents is unavailable.');
  const capabilityIds = resolveEffectiveWorkflowCapabilityIds(input.workflow.capabilityPolicy, selectedAgents);
  const mappings = await listCapabilityRoutingMappings(input.workflow.workspaceId, { activeReviewedOnly: true, capabilityIds });
  return {
    entryAgent,
    selectedAgents,
    mappings,
    scope: compileWorkflowAccessScope({ workflow: input.workflow, entryAgent, selectedAgents, mappings, actor: input.actor, approvedContextGrants: input.approvedContextGrants, exactTargets: input.exactTargets, exactRepository: input.exactRepository })
  };
}

async function genericMcpAuthRequirements(input: {
  workspaceId: string;
  userId: string;
  agents: NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>>[];
  scope: ReturnType<typeof compileWorkflowAccessScope>;
}): Promise<WorkflowCapabilitiesPreview['mcpRequirements']> {
  const allowedServerIds = new Set(input.scope.mcpServers);
  const installed = (await Promise.all(input.agents.map(async (agent) => ({
    agent,
    servers: await listAgentMcpServers(input.workspaceId, agent.id)
  })))).flatMap(({ agent, servers }) => servers.map((server) => ({ agent, server })))
    .filter(({ server }) => server.enabled
      && (server.auth_scope === 'personal' || (!server.auth_scope && server.auth_type !== 'none'))
      && allowedServerIds.has(server.id));
  return Promise.all(installed.map(async ({ agent, server }) => {
    const connection = await getMcpUserConnection(input.workspaceId, server.id, input.userId);
    const authType = server.auth_type === 'custom_header' ? 'custom_header' as const : 'bearer_token' as const;
    const credentialLabel = authType === 'bearer_token' ? 'API key or bearer token' : 'Custom header credential';
    return {
      serverId: server.id,
      serverName: server.server_name,
      authType,
      owningAgent: { id: agent.id, name: agent.name },
      connectionState: connection.status === 'connected' ? 'connected' as const
        : connection.status === 'error' ? 'connection_error' as const
          : 'connection_missing' as const,
      authRequirement: {
        scope: 'personal' as const,
        credentialLabel,
        requiredInformation: [{
          name: credentialLabel,
          description: `Provide the personal key or token issued for ${server.server_name}. AcornOps stores this value write-only and never returns it.`
        }]
      },
      action: connection.status === 'connected' ? 'none' as const
        : connection.status === 'error' ? 'verify_mcp_server' as const
          : 'connect_mcp_server' as const
    };
  }));
}

function requestedTarget(req: AuthenticatedRequest): { id: string; targetType: 'kubernetes' | 'virtual_machine' } | undefined | null {
  if (req.body?.target === undefined) return undefined;
  if (!req.body.target || typeof req.body.target !== 'object' || Array.isArray(req.body.target)) return null;
  const id = typeof req.body.target.id === 'string' ? req.body.target.id.trim() : '';
  const targetType = req.body.target.targetType;
  if (!id || (targetType !== 'kubernetes' && targetType !== 'virtual_machine')) return null;
  return { id, targetType };
}

function responseBody(input: {
  workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinition>>>;
  status: WorkflowCapabilitiesPreview['status'];
  candidates: WorkflowTargetCapabilityCandidate[];
  selectedTarget?: WorkflowTargetCapabilityCandidate;
  reasonCodes?: WorkflowCapabilityPreviewReasonCode[];
  scope?: ReturnType<typeof compileWorkflowAccessScope>;
  tools?: WorkflowCapabilityToolPreview[];
  directMcpServers?: WorkflowCapabilitiesPreview['directMcpServers'];
  enabledSkills?: WorkflowCapabilitiesPreview['enabledSkills'];
  semanticCapabilityIds?: string[];
  mcpRequirements?: WorkflowCapabilitiesPreview['mcpRequirements'];
}): WorkflowCapabilitiesPreview {
  const tools = input.tools || [];
  const read = tools.filter((tool) => tool.access === 'read');
  const write = tools.filter((tool) => tool.access === 'write');
  const directMcpServers = input.directMcpServers || [];
  const enabledSkills = input.enabledSkills || [];
  const approvalRequirements = input.scope?.approvalGates || input.workflow.capabilityPolicy.approvalRequirements;
  return {
    workflowId: input.workflow.id,
    workflowVersion: input.workflow.version,
    mode: input.workflow.capabilityPolicy.mode,
    semanticCapabilityIds: input.scope?.semanticCapabilityIds || input.semanticCapabilityIds || input.workflow.capabilityPolicy.semanticCapabilityIds,
    checkedAt: new Date().toISOString(),
    status: input.status,
    reasonCodes: input.reasonCodes || [],
    targetCandidates: input.candidates,
    ...(input.selectedTarget ? { selectedTarget: input.selectedTarget } : {}),
    ...(input.scope ? { compiledAccessScope: publicCompiledWorkflowScope(input.scope) } : {}),
    tools: { read, write },
    directMcpServers,
    enabledSkills,
    mcpRequirements: input.mcpRequirements || [],
    approvalRequirements,
    counts: {
      targets: input.candidates.length,
      readyTargets: input.candidates.filter((candidate) => candidate.status === 'ready').length,
      tools: tools.length,
      readTools: read.length,
      writeTools: write.length,
      directMcpServers: directMcpServers.length,
      enabledSkills: enabledSkills.length,
      approvals: approvalRequirements.length
    }
  };
}

export async function previewWorkflowCapabilities(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  let metricStatus: 'needs_target' | 'ready' | 'blocked' | 'error' = 'error';
  try {
    const workspaceId = requestWorkspaceId(req);
    if (!workspaceId) return void res.status(400).json({ error: { code: 'WORKFLOW_WORKSPACE_REQUIRED', message: 'workspaceId is required.', retryable: false } });
    const workflow = await getWorkflowDefinition(workspaceId, toSingleParam(req.params.workflowId));
    if (!workflow) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const requiredCapability = workflow.capabilityPolicy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
    if (!authz.can(requiredCapability)) return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No permission to preview this workflow run.', retryable: false } });
    const target = requestedTarget(req);
    if (target === null) return void res.status(400).json({ error: { code: 'WORKFLOW_PREVIEW_TARGET_INVALID', message: 'target must contain an exact id and supported targetType.', retryable: false } });
    const selectedAgents = (await Promise.all(workflow.agentIds.map((agentId) => getAgentDefinition(workspaceId, agentId))))
      .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
    const semanticCapabilityIds = resolveEffectiveWorkflowCapabilityIds(workflow.capabilityPolicy, selectedAgents);
    const [mappings, targets, registrations, selectedTargetRecord] = await Promise.all([
      listCapabilityRoutingMappings(workspaceId, { activeReviewedOnly: true, capabilityIds: semanticCapabilityIds }),
      repo.listWorkflowTargetSnapshot(workspaceId),
      repo.listWorkspaceTargetAgentRegistrations(workspaceId),
      target ? repo.getTarget(workspaceId, target.id) : Promise.resolve(null)
    ]);
    const requiresTarget = workflowRequiresExactTarget(semanticCapabilityIds) || Boolean(workflow.targetConstraints?.targetIds.length || workflow.targetConstraints?.targetTypes.length);
    const candidates = requiresTarget ? workflowTargetCandidates({ workflow, agents: selectedAgents, semanticCapabilityIds, mappings, targets, registrations }) : [];
    if (requiresTarget && !target) {
      incrementWorkflowCapabilityPreviewBlocker('TARGET_REQUIRED');
      metricStatus = 'needs_target';
      const response = responseBody({ workflow, status: 'needs_target', candidates, reasonCodes: ['TARGET_REQUIRED'], semanticCapabilityIds });
      logger.info({ workspaceId, workflowId: workflow.id, workflowVersion: workflow.version, status: response.status, targetCount: response.counts.targets, readyTargetCount: response.counts.readyTargets, toolCount: 0, reasonCodes: response.reasonCodes }, 'Workflow capability preview completed');
      return void res.status(200).json(response);
    }
    let selectedCandidate: WorkflowTargetCapabilityCandidate | undefined;
    if (target) {
      selectedCandidate = !selectedTargetRecord
        ? unavailableSelectedTarget(target, 'TARGET_NOT_FOUND')
        : selectedTargetRecord.targetType !== target.targetType
          ? unavailableSelectedTarget(selectedTargetRecord, 'TARGET_TYPE_MISMATCH')
          : candidates.find((candidate) => candidate.id === selectedTargetRecord.id) || { ...unavailableSelectedTarget(selectedTargetRecord, 'TARGET_NOT_FOUND'), reason: 'The selected target is outside this workflow scope.' };
      if (selectedCandidate.status !== 'ready') {
        metricStatus = 'blocked';
        const reasonCodes = selectedCandidate.reasonCode ? [selectedCandidate.reasonCode] : ['CAPABILITY_MAPPING_UNAVAILABLE' as const];
        const response = responseBody({ workflow, status: 'blocked', candidates, selectedTarget: selectedCandidate, reasonCodes, semanticCapabilityIds });
        logger.info({ workspaceId, workflowId: workflow.id, workflowVersion: workflow.version, targetId: selectedCandidate.id, targetType: selectedCandidate.targetType, status: response.status, targetCount: response.counts.targets, readyTargetCount: response.counts.readyTargets, toolCount: 0, reasonCodes }, 'Workflow capability preview completed');
        return void res.status(200).json(response);
      }
    }
    const previewInputs = req.body?.inputs && typeof req.body.inputs === 'object' && !Array.isArray(req.body.inputs)
      ? req.body.inputs as Record<string, unknown>
      : {};
    const compiled = await compilePreviewScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      approvedContextGrants: approvedContextGrants(req),
      exactTargets: selectedTargetRecord ? [{ id: selectedTargetRecord.id, targetType: selectedTargetRecord.targetType }] : [],
      exactRepository: resolveWorkflowRepositoryScope(workflow, previewInputs)
    });
    let scope = compiled.scope;
    let selectedTargetTools: WorkflowCapabilityToolPreview[] = [];
    let selectedTargetToolNames: string[] = [];
    if (selectedTargetRecord) {
      const resolution = await resolveTargetRunTools({ workspaceId, targetId: selectedTargetRecord.id, targetType: selectedTargetRecord.targetType, toolAccessMode: scope.mode, includeNativeTools: false, strictMcpResolution: true, resyncIfEmpty: false });
      const narrowed = narrowWorkflowScopeToTargetTools({ scope, mappings: compiled.mappings, resolution });
      scope = narrowed.scope;
      selectedTargetTools = targetPreviewTools(narrowed.targetTools);
      selectedTargetToolNames = narrowed.targetTools.allowedToolNames;
      if (compiled.scope.targetToolRefs.length > 0 && narrowed.targetTools.allowedToolRefs.length === 0) {
        incrementWorkflowCapabilityPreviewBlocker('TARGET_TOOL_CATALOG_UNAVAILABLE');
        metricStatus = 'blocked';
        const blockedTarget = { ...selectedCandidate!, status: 'unsupported' as const, reasonCode: 'TARGET_TOOL_CATALOG_UNAVAILABLE' as const, reason: 'The target tool catalog is currently unavailable.' };
        return void res.status(200).json(responseBody({ workflow, status: 'blocked', candidates, selectedTarget: blockedTarget, reasonCodes: ['TARGET_TOOL_CATALOG_UNAVAILABLE'], semanticCapabilityIds }));
      }
    }
    const readiness = await getWorkflowCapabilityReadinessReport(workspaceId, scope, selectedTargetRecord || undefined, { principal: scope.principal });
    const attachments = directWorkflowAttachments({ agent: compiled.entryAgent, scope, target: selectedTargetRecord || undefined, excludedToolNames: selectedTargetToolNames });
    const genericAuthRequirements = await genericMcpAuthRequirements({ workspaceId, userId: req.auth.userId, agents: compiled.selectedAgents, scope });
    const mcpRequirements = genericAuthRequirements;
    const tools = [...selectedTargetTools, ...attachments.tools].filter((tool, index, values) => values.findIndex((candidate) => candidate.id === tool.id && candidate.source === tool.source) === index);
    const reasonCodes: WorkflowCapabilityPreviewReasonCode[] = readiness.errors.length ? ['MCP_CONNECTION_UNAVAILABLE'] : [];
    reasonCodes.forEach(incrementWorkflowCapabilityPreviewBlocker);
    metricStatus = readiness.errors.length ? 'blocked' : 'ready';
    const response = responseBody({ workflow, status: metricStatus, candidates, selectedTarget: selectedCandidate, reasonCodes, scope, tools, directMcpServers: attachments.mcpServers, enabledSkills: attachments.skills, mcpRequirements });
    logger.info({ workspaceId, workflowId: workflow.id, workflowVersion: workflow.version, targetId: selectedCandidate?.id, targetType: selectedCandidate?.targetType, status: response.status, targetCount: response.counts.targets, readyTargetCount: response.counts.readyTargets, toolCount: response.counts.tools, readToolCount: response.counts.readTools, writeToolCount: response.counts.writeTools, reasonCodes }, 'Workflow capability preview completed');
    res.status(200).json(response);
  } catch (error) {
    if (error instanceof WorkflowAccessDeniedError) return accessError(res, error);
    if (error instanceof WorkflowInputValidationError) {
      return void res.status(400).json({ error: { code: error.code, message: error.message, retryable: false, details: { field: error.field } } });
    }
    logger.warn({ workflowId: toSingleParam(req.params.workflowId), status: 'error' }, 'Workflow capability preview failed');
    next(error);
  } finally {
    observeWorkflowCapabilityPreview(metricStatus, Date.now() - startedAt);
  }
}
