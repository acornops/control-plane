import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import {
  agentConversationPolicyAllowsAccess,
  compileAgentConversationRunScope
} from '../services/agent-chat.js';
import { CapabilityAccessDeniedError } from '../services/capability-access-errors.js';
import { getExactMcpReadinessReport, publicMcpReadinessError } from '../services/mcp-readiness.js';
import { WEB_SEARCH_TOOL_ID } from '../services/provider-native-tool-ids.js';
import {
  capabilityForToolAccessMode,
  missingToolAccessModeCapabilityMessage,
  parseToolAccessMode
} from '../services/run-tool-access-mode.js';
import { sanitizeToolText } from '../services/tool-metadata.js';
import { getWorkspaceNativeTool } from '../services/workspace-native-tools.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import type { CompiledAgentChatAccessScope } from '../types/agent-chat.js';
import { toSingleParam } from '../utils/params.js';

interface AgentCapabilityPreviewTool {
  id: string;
  name: string;
  label?: string;
  description: string;
  capability: 'read' | 'write';
  runtimeKind: 'function' | 'provider_native';
  source: 'builtin' | 'mcp' | 'provider_native';
}

function toolRefKey(ref: { serverId: string; toolName: string }): string {
  return `${ref.serverId}\u0000${ref.toolName}`;
}

function previewTools(
  agent: AgentDefinition,
  scope: CompiledAgentChatAccessScope
): AgentCapabilityPreviewTool[] {
  const scopedMcpRefs = new Set(scope.mcpTools.map(toolRefKey));
  const mcpTools = agent.mcpInstallations.flatMap((installation) => {
    if (!installation.enabled) return [];
    return installation.tools
      .filter((tool) => tool.enabled
        && tool.reviewState === 'approved'
        && scopedMcpRefs.has(toolRefKey(tool))
        && scope.tools.includes(tool.alias))
      .map((tool) => ({
        id: `${tool.serverId}:${tool.toolName}`,
        name: tool.alias,
        label: tool.toolName,
        description: sanitizeToolText(tool.description)
          || `Execute reviewed MCP tool "${tool.toolName}".`,
        capability: scope.toolOperations[tool.alias] || tool.capability,
        runtimeKind: 'function' as const,
        source: 'mcp' as const
      }));
  });
  const nativeTools = scope.tools.flatMap((toolId) => {
    const definition = getWorkspaceNativeTool(toolId);
    if (!definition || !definition.invocationScopes.includes('agent_chat')) return [];
    return [{
      id: definition.id,
      name: definition.modelAlias,
      label: definition.title,
      description: definition.description,
      capability: scope.toolOperations[toolId] || definition.approvalOperation,
      runtimeKind: 'function' as const,
      source: 'builtin' as const
    }];
  });
  const providerNativeTools = scope.tools.includes(WEB_SEARCH_TOOL_ID)
    ? [{
        id: WEB_SEARCH_TOOL_ID,
        name: WEB_SEARCH_TOOL_ID,
        label: 'Web Search',
        description: 'Search the web through the selected LLM provider.',
        capability: 'read' as const,
        runtimeKind: 'provider_native' as const,
        source: 'provider_native' as const
      }]
    : [];

  return [...nativeTools, ...mcpTools, ...providerNativeTools]
    .sort((left, right) => (left.label || left.name).localeCompare(right.label || right.name));
}

function hasConfiguredWriteTools(agent: AgentDefinition): boolean {
  return agent.mcpInstallations.some((installation) => installation.enabled
    && installation.tools.some((tool) => tool.enabled
      && tool.reviewState === 'approved'
      && tool.capability === 'write'))
    || agent.tools.some((toolId) => getWorkspaceNativeTool(toolId)?.approvalOperation === 'write');
}

export function buildAgentAssistantCapabilitiesPreview(
  agent: AgentDefinition,
  scope: CompiledAgentChatAccessScope,
  toolAccessMode: 'read_only' | 'read_write'
) {
  const tools = previewTools(agent, scope);
  const skills = agent.skillInstallations
    .filter((skill) => skill.enabled && scope.enabledSkills.includes(skill.id))
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source.type === 'manual' ? 'manual' as const : 'git_import' as const
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const readAllowed = tools.filter((tool) => tool.capability === 'read').length;
  const writeAllowed = tools.length - readAllowed;
  const configuredWriteTools = hasConfiguredWriteTools(agent);

  return {
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    toolAccessMode,
    confirmationRequiredForWrite: writeAllowed > 0 && scope.approvalGates.includes('tool_write'),
    writeUnavailableReason: configuredWriteTools && writeAllowed === 0
      ? agent.permissionMode === 'read_only' ? 'agent_write_disabled' as const : 'run_read_only' as const
      : null,
    unavailableMcpToolCount: 0,
    toolSummary: {
      totalAllowed: tools.length,
      nativeAllowed: tools.filter((tool) => tool.source !== 'mcp').length,
      readAllowed,
      writeAllowed
    },
    skillSummary: { totalAvailable: skills.length },
    tools,
    skills
  };
}

export async function getAgentAssistantCapabilitiesPreview(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const agentId = toSingleParam(req.params.agentId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;

    const toolAccessMode = parseToolAccessMode(
      toSingleParam(req.query.toolAccessMode as string | string[] | undefined)
    );
    if (!toolAccessMode) {
      return void res.status(400).json({ error: {
        code: 'VALIDATION_ERROR',
        message: 'toolAccessMode must be either read_only or read_write',
        retryable: false
      } });
    }
    const runCapability = capabilityForToolAccessMode(toolAccessMode);
    if (!authz.can(runCapability)) {
      return void res.status(403).json({ error: {
        code: 'FORBIDDEN',
        message: missingToolAccessModeCapabilityMessage(toolAccessMode),
        retryable: false
      } });
    }

    const agent = await getAgentDefinition(workspaceId, agentId);
    if (!agent) {
      return void res.status(404).json({ error: {
        code: 'NOT_FOUND', message: 'Agent not found', retryable: false
      } });
    }
    if (agent.status !== 'active'
      || agent.reviewState !== 'reviewed'
      || agent.readiness.status !== 'ready') {
      return void res.status(409).json({ error: {
        code: 'AGENT_CHAT_NOT_READY',
        message: agent.readiness.reasons[0] || 'Agent is not ready for chat.',
        retryable: false
      } });
    }
    if (!agentConversationPolicyAllowsAccess(agent.permissionMode, toolAccessMode)) {
      return void res.status(409).json({ error: {
        code: 'AGENT_CONVERSATION_POLICY_READ_ONLY',
        message: 'The Agent policy permits read-only runs only.',
        retryable: false
      } });
    }

    const scope = await compileAgentConversationRunScope({
      agent,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      accessMode: toolAccessMode
    });
    const readiness = await getExactMcpReadinessReport(
      workspaceId,
      scope.principal,
      scope.mcpTools
    );
    if (readiness.errors.length > 0) {
      return void res.status(409).json({ error: publicMcpReadinessError(readiness) });
    }

    res.status(200).json(buildAgentAssistantCapabilitiesPreview(agent, scope, toolAccessMode));
  } catch (error) {
    if (error instanceof CapabilityAccessDeniedError) {
      const permissionDenied = error.code === 'CAPABILITY_PERMISSION_DENIED';
      return void res.status(permissionDenied ? 403 : 409).json({ error: {
        code: permissionDenied ? 'FORBIDDEN' : 'AGENT_CHAT_NOT_READY',
        message: error.message,
        retryable: !permissionDenied
      } });
    }
    next(error);
  }
}
