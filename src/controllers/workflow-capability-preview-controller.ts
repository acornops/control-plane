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
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import { toSingleParam } from '../utils/params.js';
import { publicCompiledWorkflowScope, respondWorkflowAccessError } from './workflow-public.js';
import { getMcpConnection, listAgentMcpServers, listTargetMcpServers, type McpServerConfig } from '../services/mcp-registry-client.js';
import { builtinTargetMcpServerDisplayName } from '../services/kubernetes-cluster-tools-catalog.js';
import { workflowTargetPolicy } from '../services/prompt-resources/providers/target-provider.js';
import { promptResourceRegistry } from '../services/prompt-resources/index.js';
import { isTargetType, type TargetSummary } from '../types/domain.js';

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function approvedContextGrants(req: AuthenticatedRequest): string[] {
  return Array.isArray(req.body.approvedContextGrants)
    ? req.body.approvedContextGrants.filter((value: unknown): value is string => typeof value === 'string')
    : [];
}

async function compilePreviewScope(input: {
  workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinition>>>;
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
  targetRoute?: { id: string; targetType: 'kubernetes' | 'virtual_machine' };
  resourceBindings: PromptResourceBinding[];
  promptDigest: string;
  bindingDigest: string;
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
    scope: compileWorkflowAccessScope({
      workflow: input.workflow, entryAgent, selectedAgents, mappings, actor: input.actor,
      approvedContextGrants: input.approvedContextGrants, targetRoute: input.targetRoute,
      resourceBindings: input.resourceBindings, promptDigest: input.promptDigest, bindingDigest: input.bindingDigest
    })
  };
}

export async function genericMcpAuthRequirements(input: {
  workspaceId: string;
  userId: string;
  agents: NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>>[];
  scope: ReturnType<typeof compileWorkflowAccessScope>;
  target?: TargetSummary;
}): Promise<WorkflowCapabilitiesPreview['mcpRequirements']> {
  const allowedServerIds = new Set(input.scope.mcpServers);
  const installedAgentServers = (await Promise.all(input.agents.map(async (agent) => ({
    agent,
    servers: await listAgentMcpServers(input.workspaceId, agent.id)
  })))).flatMap(({ agent, servers }) => servers.map((server) => ({ agent, server })))
    .filter(({ server }) => server.enabled
      && server.credential_mode !== 'none'
      && allowedServerIds.has(server.id));
  const allowedTargetServerIds = new Set(input.scope.targetToolRefs.map((ref) => ref.serverId));
  const installedTargetServers = input.target
    ? (await listTargetMcpServers(input.workspaceId, input.target.id, input.target.targetType))
      .filter((server) => server.enabled
        && server.credential_mode !== 'none'
        && allowedTargetServerIds.has(server.id))
    : [];

  const requirementForServer = async (
    server: McpServerConfig,
    owner: { owningAgent: { id: string; name: string } } | { owningTarget: { id: string; name: string; targetType: TargetSummary['targetType'] } },
    serverName = server.server_name
  ): Promise<WorkflowCapabilitiesPreview['mcpRequirements'][number]> => {
    const credentialMode = server.credential_mode === 'workspace'
      ? 'workspace' as const
      : 'individual' as const;
    const workspaceManaged = credentialMode === 'workspace';
    const connection = await getMcpConnection(
      input.workspaceId,
      server.id,
      workspaceManaged ? 'installation' : 'user',
      workspaceManaged ? 'installation' : input.userId
    );
    const authType = server.auth_type === 'custom_header' ? 'custom_header' as const : 'bearer_token' as const;
    const credentialLabel = authType === 'bearer_token' ? 'API key or bearer token' : 'Custom header credential';
    return {
      serverId: server.id,
      serverName,
      authType,
      ...owner,
      connectionState: connection.status === 'connected' ? 'connected' as const
        : connection.status === 'error' ? 'connection_error' as const
          : 'connection_missing' as const,
      authRequirement: {
        scope: credentialMode,
        credentialLabel,
        requiredInformation: [{
          name: credentialLabel,
          description: workspaceManaged
            ? `Provide a service or bot credential for ${serverName}. Authorized users and automations, including service identities, will use it.`
            : `Provide your credential for ${serverName}. AcornOps stores it privately and never returns it. User-owned schedules that run as you will use this connection.`
        }]
      },
      action: connection.status === 'connected' ? 'none' as const
        : connection.status === 'error' ? 'verify_mcp_server' as const
          : 'connect_mcp_server' as const
    };
  };

  const agentRequirements = installedAgentServers.map(({ agent, server }) => requirementForServer(
    server,
    { owningAgent: { id: agent.id, name: agent.name } }
  ));
  const targetRequirements = input.target
    ? installedTargetServers.map((server) => requirementForServer(
        server,
        { owningTarget: { id: input.target!.id, name: input.target!.name, targetType: input.target!.targetType } },
        server.provenance_type === 'builtin'
          ? builtinTargetMcpServerDisplayName(input.target!.targetType)
          : server.server_name
      ))
    : [];
  return Promise.all([...agentRequirements, ...targetRequirements]);
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
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : workflow.prompt;
    const referenceResolution = await promptResourceRegistry.resolve(content, {
      workspaceId,
      actorUserId: req.auth.userId,
      workflowId: workflow.id,
      mode: 'launch',
      requirements: workflow.resourceRequirements
    });
    if (referenceResolution.blockers.length > 0) {
      return void res.status(409).json({ error: {
        code: 'WORKFLOW_PROMPT_REFERENCES_BLOCKED',
        message: referenceResolution.blockers.map((blocker) => blocker.message).join(' '),
        retryable: referenceResolution.blockers.some((blocker) => blocker.retryable),
        details: { blockers: referenceResolution.blockers }
      } });
    }
    const runtimeProjection = promptResourceRegistry.projectRuntime(referenceResolution.bindings, 'capability-preview');
    const projectedTarget = runtimeProjection.targetRoute && typeof runtimeProjection.targetRoute === 'object'
      ? runtimeProjection.targetRoute as Record<string, unknown>
      : undefined;
    const target = projectedTarget && typeof projectedTarget.id === 'string'
      && typeof projectedTarget.targetType === 'string' && isTargetType(projectedTarget.targetType)
      ? { id: projectedTarget.id, targetType: projectedTarget.targetType }
      : undefined;
    const selectedAgents = (await Promise.all(workflow.agentIds.map((agentId) => getAgentDefinition(workspaceId, agentId))))
      .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
    const semanticCapabilityIds = resolveEffectiveWorkflowCapabilityIds(workflow.capabilityPolicy, selectedAgents);
    const [mappings, targets, registrations, selectedTargetRecord] = await Promise.all([
      listCapabilityRoutingMappings(workspaceId, { activeReviewedOnly: true, capabilityIds: semanticCapabilityIds }),
      repo.listWorkflowTargetSnapshot(workspaceId),
      repo.listWorkspaceTargetAgentRegistrations(workspaceId),
      target ? repo.getTarget(workspaceId, target.id) : Promise.resolve(null)
    ]);
    const targetPolicy = workflowTargetPolicy(workflow);
    const requiresTarget = workflowRequiresExactTarget(semanticCapabilityIds) || Boolean(targetPolicy?.targetIds.length || targetPolicy?.targetTypes.length);
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
    const compiled = await compilePreviewScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      approvedContextGrants: approvedContextGrants(req),
      targetRoute: selectedTargetRecord ? { id: selectedTargetRecord.id, targetType: selectedTargetRecord.targetType } : undefined,
      resourceBindings: referenceResolution.bindings,
      promptDigest: referenceResolution.promptDigest,
      bindingDigest: referenceResolution.bindingDigest
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
    const genericAuthRequirements = await genericMcpAuthRequirements({ workspaceId, userId: req.auth.userId, agents: compiled.selectedAgents, scope, target: selectedTargetRecord || undefined });
    const mcpRequirements = genericAuthRequirements;
    const tools = [...selectedTargetTools, ...attachments.tools].filter((tool, index, values) => values.findIndex((candidate) => candidate.id === tool.id && candidate.source === tool.source) === index);
    const reasonCodes: WorkflowCapabilityPreviewReasonCode[] = readiness.errors.length ? ['MCP_CONNECTION_UNAVAILABLE'] : [];
    reasonCodes.forEach(incrementWorkflowCapabilityPreviewBlocker);
    metricStatus = readiness.errors.length ? 'blocked' : 'ready';
    const response = responseBody({ workflow, status: metricStatus, candidates, selectedTarget: selectedCandidate, reasonCodes, scope, tools, directMcpServers: attachments.mcpServers, enabledSkills: attachments.skills, mcpRequirements });
    logger.info({ workspaceId, workflowId: workflow.id, workflowVersion: workflow.version, targetId: selectedCandidate?.id, targetType: selectedCandidate?.targetType, status: response.status, targetCount: response.counts.targets, readyTargetCount: response.counts.readyTargets, toolCount: response.counts.tools, readToolCount: response.counts.readTools, writeToolCount: response.counts.writeTools, reasonCodes }, 'Workflow capability preview completed');
    res.status(200).json(response);
  } catch (error) {
    if (error instanceof WorkflowAccessDeniedError) return respondWorkflowAccessError(res, error);
    logger.warn({ workflowId: toSingleParam(req.params.workflowId), status: 'error' }, 'Workflow capability preview failed');
    next(error);
  } finally {
    observeWorkflowCapabilityPreview(metricStatus, Date.now() - startedAt);
  }
}
