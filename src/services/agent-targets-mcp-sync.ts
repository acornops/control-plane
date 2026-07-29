import { config } from '../config.js';
import { logger } from '../logger.js';
import { incrementDuplicateBuiltInServerAnomaly } from '../metrics.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import { listWorkflowDefinitions } from '../store/repository-workflows.js';
import {
  createAgentMcpServer,
  listAgentMcpServers,
  updateAgentMcpServer
} from './mcp-registry-client.js';
import { syncAgentMcpCapabilitySnapshot, toAgentMcpServer } from './agent-mcp-capabilities.js';
import { refreshAgentReadiness, refreshWorkflowReadiness } from './automation-readiness.js';
import { reconcileTargetDiagnosticsForAgent } from './target-diagnostics-capability.js';
import {
  AGENT_TARGETS_MCP_SERVER_NAME,
  agentTargetsMcpTools
} from './agent-targets-mcp-catalog.js';

const PLATFORM_ACTOR = 'platform:agent-targets-mcp';

export interface AgentTargetsMcpSyncResult {
  ok: boolean;
  workspaceId: string;
  agentId: string;
  registeredToolCount: number;
  addedTools: string[];
  removedTools: string[];
  agent?: AgentDefinition;
  error?: string;
}

function targetConstraints(agent: AgentDefinition): {
  targetTypes: AgentDefinition['targetScope']['targetTypes'];
  targetIds: string[];
} {
  return {
    targetTypes: [...new Set(agent.targetScope.targetTypes || [])].sort(),
    targetIds: [...new Set(agent.targetScope.targetIds || [])].sort()
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function toolCatalogMatches(
  actual: Awaited<ReturnType<typeof listAgentMcpServers>>[number]['tools'],
  expected: ReturnType<typeof agentTargetsMcpTools>
): boolean {
  const projectActual = actual
    .map((tool) => ({
      name: tool.name,
      timeoutMs: tool.timeout_ms,
      description: tool.description,
      capability: tool.capability,
      version: tool.version,
      source: tool.source,
      inputSchema: tool.input_schema,
      outputSchema: tool.output_schema,
      artifactPolicy: tool.artifact_policy,
      enabled: tool.enabled,
      reviewState: tool.review_state,
      riskLevel: tool.risk_level,
      autoAllowed: tool.auto_allowed === true
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return stable(projectActual) === stable([...expected].sort((left, right) => left.name.localeCompare(right.name)));
}

function snapshotMatches(agent: AgentDefinition, server: Awaited<ReturnType<typeof listAgentMcpServers>>[number]): boolean {
  const installation = agent.mcpInstallations.find((item) => item.id === server.id);
  if (!installation) return false;
  const expected = toAgentMcpServer(server);
  const projectTool = (tool: AgentDefinition['mcpInstallations'][number]['tools'][number]) => ({
    serverId: tool.serverId,
    toolName: tool.toolName,
    alias: tool.alias,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    capability: tool.capability,
    enabled: tool.enabled,
    reviewState: tool.reviewState,
    riskLevel: tool.riskLevel,
    autoAllowed: tool.autoAllowed
  });
  const projectInstallation = (
    item: Pick<typeof installation, 'id' | 'name' | 'url' | 'enabled' | 'credentialMode' | 'revision' | 'targetConstraints'>
      & { tools: AgentDefinition['mcpInstallations'][number]['tools'] }
  ) => ({
    id: item.id,
    name: item.name,
    url: item.url,
    enabled: item.enabled,
    credentialMode: item.credentialMode,
    revision: item.revision,
    targetConstraints: {
      targetTypes: [...item.targetConstraints.targetTypes].sort(),
      targetIds: [...item.targetConstraints.targetIds].sort()
    },
    tools: item.tools.map(projectTool)
      .sort((left, right) => `${left.serverId}\0${left.toolName}`.localeCompare(`${right.serverId}\0${right.toolName}`))
  });
  const expectedInstallation = {
    ...expected,
    tools: expected.tools.map((tool) => ({
      serverId: tool.serverId,
      toolName: tool.name,
      alias: tool.alias,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      capability: tool.capability,
      enabled: tool.enabled,
      reviewState: tool.reviewState,
      riskLevel: tool.riskLevel,
      autoAllowed: tool.autoAllowed
    }))
  };
  return stable(projectInstallation(installation))
    === stable(projectInstallation(expectedInstallation));
}

async function reconcileCapabilityState(agent: AgentDefinition): Promise<AgentDefinition> {
  await reconcileTargetDiagnosticsForAgent(agent);
  const refreshed = (await refreshAgentReadiness(agent.workspaceId, agent.id)) || agent;
  await Promise.all((await listWorkflowDefinitions(agent.workspaceId))
    .filter((workflow) => workflow.agentIds.includes(agent.id))
    .map((workflow) => refreshWorkflowReadiness(workflow)));
  return refreshed;
}

export async function syncAgentTargetsBuiltInTools(
  workspaceId: string,
  agentId: string,
  options: { initializeVersion?: number } = {}
): Promise<AgentTargetsMcpSyncResult> {
  try {
    const agent = await getAgentDefinition(workspaceId, agentId);
    if (!agent) throw new Error('Agent not found');
    const tools = agentTargetsMcpTools(config.ASSISTANT_TOOL_DEFAULT_TIMEOUT_MS);
    const expectedNames = new Set<string>(tools.map((tool) => tool.name));
    const servers = await listAgentMcpServers(workspaceId, agentId);
    const builtinServers = servers.filter((server) => server.provenance_type === 'builtin');
    if (builtinServers.length > 1) {
      incrementDuplicateBuiltInServerAnomaly('agent');
      throw new Error('MCP_DUPLICATE_BUILTIN_SERVER_ANOMALY');
    }
    const existing = builtinServers[0];
    const existingNames = new Set(
      (existing?.tools || []).map((tool) => tool.name)
    );
    const removeTools = [...existingNames].filter((name) => !expectedNames.has(name));
    const constraints = targetConstraints(agent);
    let server = existing;
    let changed = false;

    if (!existing) {
      server = await createAgentMcpServer({
        workspaceId,
        agentId,
        name: AGENT_TARGETS_MCP_SERVER_NAME,
        url: config.BUILTIN_TARGET_MCP_SERVER_URL,
        enabled: true,
        auth: { type: 'none' },
        credentialMode: 'none',
        targetConstraints: constraints,
        tools
      });
      changed = true;
    } else {
      const currentConstraints = {
        targetTypes: existing.target_constraints?.target_types || [],
        targetIds: existing.target_constraints?.target_ids || []
      };
      const catalogChanged = !toolCatalogMatches(existing.tools, tools);
      const serverChanged = existing.server_name !== AGENT_TARGETS_MCP_SERVER_NAME
        || existing.server_url !== config.BUILTIN_TARGET_MCP_SERVER_URL
        || stable(currentConstraints) !== stable(constraints)
        || existing.auth_type !== 'none'
        || existing.credential_mode !== 'none'
        || Boolean(existing.auth_header_name)
        || Boolean(existing.auth_header_prefix)
        || Object.keys(existing.public_headers || {}).length > 0;
      if (catalogChanged || serverChanged || removeTools.length > 0) {
        server = await updateAgentMcpServer({
          workspaceId,
          agentId,
          serverId: existing.id,
          name: AGENT_TARGETS_MCP_SERVER_NAME,
          url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          enabled: existing.enabled,
          auth: { type: 'none' },
          credentialMode: 'none',
          publicHeaders: {},
          targetConstraints: constraints,
          tools,
          removeTools
        });
        changed = true;
      }
    }

    if (!server) throw new Error('Built-in Agent Targets MCP server was not registered');
    let syncedAgent = agent;
    const snapshotOutOfSync = !snapshotMatches(agent, server);
    if (changed || snapshotOutOfSync) {
      const initializing = options.initializeVersion === agent.version
        && agent.mcpInstallations.length === 0;
      const snapshot = await syncAgentMcpCapabilitySnapshot(
        workspaceId,
        agentId,
        agent.ownerUserId || PLATFORM_ACTOR,
        {
          expectedVersion: agent.version,
          rebindActiveMappings: !initializing,
          incrementVersion: !initializing
        }
      );
      if (!snapshot.agent) {
        throw new Error('AGENT_TARGETS_MCP_CONCURRENT_MODIFICATION');
      }
      syncedAgent = await reconcileCapabilityState(snapshot.agent);
    }
    const addedTools = [...expectedNames].filter((name) => !existingNames.has(name));
    if (changed || snapshotOutOfSync) {
      logger.info({
        workspaceId,
        agentId,
        registeredToolCount: server.tools.filter((tool) => expectedNames.has(tool.name)).length,
        addedToolCount: addedTools.length,
        removedToolCount: removeTools.length,
        registryChanged: changed,
        snapshotRepaired: snapshotOutOfSync
      }, 'Synchronized built-in Agent Targets MCP tools');
    }
    return {
      ok: true,
      workspaceId,
      agentId,
      registeredToolCount: server.tools.filter((tool) => expectedNames.has(tool.name)).length,
      addedTools,
      removedTools: removeTools,
      agent: syncedAgent
    };
  } catch (error) {
    logger.warn({ workspaceId, agentId, error }, 'Failed synchronizing built-in Agent Targets MCP tools');
    return {
      ok: false,
      workspaceId,
      agentId,
      registeredToolCount: 0,
      addedTools: [],
      removedTools: [],
      error: error instanceof Error ? error.message : 'Agent Targets MCP sync failed'
    };
  }
}
