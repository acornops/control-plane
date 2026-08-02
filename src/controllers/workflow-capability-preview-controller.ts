import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { logger } from '../logger.js';
import { incrementWorkflowCapabilityPreviewBlocker, observeWorkflowCapabilityPreview } from '../metrics.js';
import {
  resolveWorkflowRoutingSnapshot,
  type WorkflowRoutingSnapshot
} from '../services/automation-readiness.js';
import { directWorkflowAttachments } from '../services/workflow-capability-preview.js';
import { compileWorkflowAccessScope, WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { getWorkflowCapabilityReadinessReport } from '../services/mcp-readiness.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowAccessActor, WorkflowCapabilitiesPreview, WorkflowCapabilityPreviewReasonCode, WorkflowCapabilityToolPreview } from '../types/workflows.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import { toSingleParam } from '../utils/params.js';
import { respondWorkflowAccessError } from './workflow-public.js';
import { getMcpConnection, listAgentMcpServers, type McpServerConfig } from '../services/mcp-registry-client.js';
import { PromptResourceProviderError } from '../services/prompt-resources/errors.js';
import { summarizeWorkflowAgents } from '../services/workflow-derived-capabilities.js';
import {
  compileWorkflowPrompt,
  WorkflowPromptValidationError
} from '../services/workflow-prompt.js';

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

async function compilePreviewScope(input: {
  workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinition>>>;
  actor: WorkflowAccessActor;
  resourceBindings: PromptResourceBinding[];
  promptDigest: string;
  bindingDigest: string;
  routingSnapshot: WorkflowRoutingSnapshot;
}) {
  const { readiness, selectedAgents, specialistAgent, mappings } = input.routingSnapshot;
  if (readiness.status !== 'ready') {
    throw new WorkflowAccessDeniedError('WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE', readiness.reasons.slice(0, 4).join(' ') || 'Selected workflow Agents are not ready.');
  }
  return {
    specialistAgent,
    selectedAgents,
    mappings,
    scope: compileWorkflowAccessScope({
      workflow: input.workflow, specialistAgent, selectedAgents, mappings, actor: input.actor,
      resourceBindings: input.resourceBindings, promptDigest: input.promptDigest, bindingDigest: input.bindingDigest
    })
  };
}

export async function genericMcpAuthRequirements(input: {
  workspaceId: string;
  userId: string;
  agents: AgentDefinition[];
  scope: ReturnType<typeof compileWorkflowAccessScope>;
}): Promise<WorkflowCapabilitiesPreview['mcpRequirements']> {
  const allowedServerIds = new Set(input.scope.mcpServers);
  if (allowedServerIds.size === 0) return [];
  const installedAgentServers = (await Promise.all(input.agents.map(async (agent) => ({
    agent,
    servers: await listAgentMcpServers(input.workspaceId, agent.id)
  })))).flatMap(({ agent, servers }) => servers.map((server) => ({ agent, server })))
    .filter(({ server }) => server.enabled
      && server.credential_mode !== 'none'
      && allowedServerIds.has(server.id));
  const requirementForServer = async (
    server: McpServerConfig,
    owner: { owningAgent: { id: string; name: string } },
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
    const authType = server.auth_type === 'oauth'
      ? 'oauth' as const
      : server.auth_type === 'custom_header' ? 'custom_header' as const : 'bearer_token' as const;
    const credentialLabel = authType === 'oauth'
      ? 'OAuth browser authorization'
      : authType === 'bearer_token' ? 'API key or bearer token' : 'Custom header credential';
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
          description: authType === 'oauth'
            ? `Authorize your account for ${serverName} in a browser. AcornOps stores the resulting user connection privately.`
            : workspaceManaged
            ? `Provide a service or bot credential for ${serverName}. Authorized users and automations, including service identities, will use it.`
            : `Provide your credential for ${serverName}. AcornOps stores it privately and never returns it. User-owned schedules that run as you will use this connection.`
        }]
      },
      action: connection.status === 'connected' ? 'none' as const
        : connection.action || (connection.status === 'error' ? 'verify_mcp_server' as const
          : 'connect_mcp_server' as const
        )
    };
  };

  const agentRequirements = installedAgentServers.map(({ agent, server }) => requirementForServer(
    server,
    { owningAgent: { id: agent.id, name: agent.name } }
  ));
  return Promise.all(agentRequirements);
}

function responseBody(input: {
  workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinition>>>;
  promptDigest: string;
  bindingDigest: string;
  status: WorkflowCapabilitiesPreview['status'];
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
  const approvalRequirements = input.scope?.approvalGates || [];
  return {
    workflowId: input.workflow.id,
    promptDigest: input.promptDigest,
    bindingDigest: input.bindingDigest,
    mode: input.scope?.mode || 'read_only',
    semanticCapabilityIds: input.scope?.semanticCapabilityIds || input.semanticCapabilityIds || [],
    checkedAt: new Date().toISOString(),
    status: input.status,
    reasonCodes: input.reasonCodes || [],
    tools: { read, write },
    directMcpServers,
    enabledSkills,
    mcpRequirements: input.mcpRequirements || [],
    approvalRequirements,
    counts: {
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
  let metricStatus: 'ready' | 'blocked' | 'error' = 'error';
  try {
    const workspaceId = requestWorkspaceId(req);
    if (!workspaceId) return void res.status(400).json({ error: { code: 'WORKFLOW_WORKSPACE_REQUIRED', message: 'workspaceId is required.', retryable: false } });
    const workflow = await getWorkflowDefinition(workspaceId, toSingleParam(req.params.workflowId));
    if (!workflow) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow not found', retryable: false } });
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const routingSnapshot = await resolveWorkflowRoutingSnapshot(workflow);
    const requiredCapability = summarizeWorkflowAgents(routingSnapshot.selectedAgents).mode === 'read_write'
      ? 'create_read_write_runs'
      : 'create_read_only_runs';
    if (!authz.can(requiredCapability)) return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No permission to preview this workflow run.', retryable: false } });
    const referenceResolution = await compileWorkflowPrompt({
      workflow,
      actorUserId: req.auth.userId
    });
    const compiled = await compilePreviewScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      resourceBindings: referenceResolution.bindings,
      promptDigest: referenceResolution.promptDigest,
      bindingDigest: referenceResolution.bindingDigest,
      routingSnapshot
    });
    const scope = compiled.scope;
    const readiness = await getWorkflowCapabilityReadinessReport(workspaceId, scope, { principal: scope.principal });
    const attachments = compiled.specialistAgent
      ? directWorkflowAttachments({ agent: compiled.specialistAgent, scope })
      : { tools: [], mcpServers: [], skills: [] };
    const genericAuthRequirements = await genericMcpAuthRequirements({ workspaceId, userId: req.auth.userId, agents: compiled.selectedAgents, scope });
    const mcpRequirements = genericAuthRequirements;
    const tools = attachments.tools;
    const reasonCodes: WorkflowCapabilityPreviewReasonCode[] = readiness.errors.length ? ['MCP_CONNECTION_UNAVAILABLE'] : [];
    reasonCodes.forEach(incrementWorkflowCapabilityPreviewBlocker);
    metricStatus = readiness.errors.length ? 'blocked' : 'ready';
    const response = responseBody({
      workflow,
      promptDigest: referenceResolution.promptDigest,
      bindingDigest: referenceResolution.bindingDigest,
      status: metricStatus,
      reasonCodes,
      scope,
      tools,
      directMcpServers: attachments.mcpServers,
      enabledSkills: attachments.skills,
      mcpRequirements
    });
    logger.info({ workspaceId, workflowId: workflow.id, status: response.status, toolCount: response.counts.tools, readToolCount: response.counts.readTools, writeToolCount: response.counts.writeTools, reasonCodes }, 'Workflow capability preview completed');
    res.status(200).json(response);
  } catch (error) {
    if (error instanceof WorkflowAccessDeniedError) return respondWorkflowAccessError(res, error);
    if (error instanceof WorkflowPromptValidationError) {
      return void res.status(400).json({ error: {
        code: 'WORKFLOW_PROMPT_INVALID',
        message: error.message,
        retryable: false,
        details: { errors: error.errors }
      } });
    }
    if (error instanceof PromptResourceProviderError) {
      return void res.status(409).json({ error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable
      } });
    }
    logger.warn({ workflowId: toSingleParam(req.params.workflowId), status: 'error' }, 'Workflow capability preview failed');
    next(error);
  } finally {
    observeWorkflowCapabilityPreview(metricStatus, Date.now() - startedAt);
  }
}
