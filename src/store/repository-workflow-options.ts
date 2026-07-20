import { performance } from 'node:perf_hooks';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementWorkflowCatalogSource } from '../metrics.js';
import type {
  WorkflowCatalogSourceAvailability,
  WorkflowCatalogSourceName,
  WorkflowOption,
  WorkflowOptionsCatalog
} from '../types/workflows.js';
import { effectiveWorkflowRuntimePolicy } from '../services/workflow-runtime-policy.js';

type CatalogSourceResult = {
  options: WorkflowOption[];
  availability: WorkflowCatalogSourceAvailability;
};

type CatalogLoader = () => Promise<CatalogSourceResult>;
type CatalogLoaderOverride = (workspaceId: string) => Promise<WorkflowOptionsCatalog>;

let catalogLoaderOverride: CatalogLoaderOverride | undefined;

export function configureWorkflowOptionsCatalogLoaderForTests(loader?: CatalogLoaderOverride): void {
  catalogLoaderOverride = loader;
}

interface AgentCapabilityRow extends AgentRow {
  tools: string[];
  skills: string[];
  mcp_servers: string[];
  mcp_installations: Array<{
    id: string; name: string; enabled: boolean;
    tools: Array<{ serverId: string; toolName: string; alias: string; capability: 'read' | 'write'; enabled: boolean; reviewState: string }>;
  }>;
  skill_installations: Array<{ id: string; name: string; description: string; enabled: boolean }>;
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

function availability(options: WorkflowOption[], emptyMessage: string): WorkflowCatalogSourceAvailability {
  return options.length > 0
    ? { status: 'available' }
    : { status: 'empty', message: emptyMessage, retryable: false };
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return `DATABASE_${error.code.replace(/[^A-Z0-9_]/gi, '').toUpperCase() || 'QUERY_FAILED'}`;
  }
  return 'CATALOG_QUERY_FAILED';
}

async function runSource(
  workspaceId: string,
  source: WorkflowCatalogSourceName,
  loader: CatalogLoader
): Promise<CatalogSourceResult> {
  const startedAt = performance.now();
  try {
    const result = await loader();
    const latencyMs = Math.round(performance.now() - startedAt);
    incrementWorkflowCatalogSource(source, result.availability.status);
    logger.info({ workspaceId, source, outcome: result.availability.status, latencyMs }, 'Loaded workflow catalog source');
    return result;
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const errorCode = safeErrorCode(error);
    incrementWorkflowCatalogSource(source, 'error');
    logger.warn({ workspaceId, source, outcome: 'error', latencyMs, errorCode }, 'Failed loading workflow catalog source');
    return {
      options: [],
      availability: {
        status: 'error',
        message: 'This catalog source could not be loaded. Try again.',
        retryable: true,
        errorCode
      }
    };
  }
}

async function loadAgentCapabilities(workspaceId: string, agentId?: string): Promise<{
  servers: CatalogSourceResult; tools: CatalogSourceResult; skills: CatalogSourceResult;
}> {
  const result = await db.query<AgentCapabilityRow>(
    `SELECT id, name, description, status, tools, skills, mcp_servers, mcp_installations, skill_installations
     FROM agent_definitions
     WHERE workspace_id = $1 AND kind = 'specialist' AND ($2::text IS NULL OR id = $2)
     ORDER BY name ASC, id ASC`,
    [workspaceId, agentId || null]
  );
  const active = result.rows.filter((agent) => agent.status === 'active');
  const serverOptions = active.flatMap((agent) => {
    const installed = new Map((agent.mcp_installations || []).map((server) => [server.id, server]));
    return (agent.mcp_servers || []).map((serverId) => {
      const server = installed.get(serverId);
      return {
        value: serverId,
        label: server?.name || serverId,
        description: `${agent.name} capability`,
        disabled: server ? !server.enabled : false,
        disabledReason: server && !server.enabled ? 'Disabled on selected Agent' : undefined,
        provenance: { source: 'agent' as const, agentId: agent.id }
      };
    });
  });
  const remoteTools = active.flatMap((agent) => (agent.mcp_installations || []).flatMap((server) => server.tools
    .filter((tool) => server.enabled && tool.enabled && tool.reviewState === 'approved')
    .map((tool) => ({
      value: tool.alias,
      label: tool.toolName,
      description: `${agent.name} · ${server.name} · ${tool.capability}`,
      provenance: { source: 'agent' as const, agentId: agent.id, serverId: tool.serverId, toolName: tool.toolName }
    }))));
  const localTools = active.flatMap((agent) => (agent.tools || []).map((tool) => ({
    value: tool, label: tool, description: `${agent.name} built-in capability`,
    provenance: { source: 'agent' as const, agentId: agent.id }
  })));
  const installedSkills = active.flatMap((agent) => (agent.skill_installations || [])
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      value: skill.id, label: skill.name, description: `${skill.description} · ${agent.name}`,
      provenance: { source: 'agent' as const, agentId: agent.id }
    })));
  const installedSkillIds = new Set(installedSkills.map((skill) => `${skill.provenance.agentId}\u0000${skill.value}`));
  const systemSkills = active.flatMap((agent) => (agent.skills || [])
    .filter((skill) => !installedSkillIds.has(`${agent.id}\u0000${skill}`))
    .map((skill) => ({
      value: skill, label: skill, description: `${agent.name} built-in skill`,
      provenance: { source: 'agent' as const, agentId: agent.id }
    })));
  const toolOptions = [...localTools, ...remoteTools];
  const skillOptions = [...installedSkills, ...systemSkills];
  return {
    servers: { options: serverOptions, availability: availability(serverOptions, 'The selected Agent has no MCP servers.') },
    tools: { options: toolOptions, availability: availability(toolOptions, 'The selected Agent has no tools.') },
    skills: { options: skillOptions, availability: availability(skillOptions, 'The selected Agent has no skills.') }
  };
}

async function loadAgents(workspaceId: string): Promise<CatalogSourceResult> {
  const result = await db.query<AgentRow>(
    `SELECT id, name, description, status
     FROM agent_definitions
     WHERE workspace_id = $1 AND kind = 'specialist'
     ORDER BY name ASC, id ASC`,
    [workspaceId]
  );
  const options = result.rows.map((row) => ({
    value: row.id,
    label: row.name,
    description: row.description || undefined,
    disabled: row.status !== 'active',
    disabledReason: row.status !== 'active' ? 'Agent disabled' : undefined,
    provenance: { source: 'workspace' as const }
  }));
  return { options, availability: availability(options, 'No specialist agents are available.') };
}

export async function getWorkflowOptionsCatalog(workspaceId: string, agentId?: string): Promise<WorkflowOptionsCatalog> {
  if (catalogLoaderOverride) return catalogLoaderOverride(workspaceId);
  const capabilities = loadAgentCapabilities(workspaceId, agentId);
  const [mcpServers, mcpTools, skills, agents] = await Promise.all([
    runSource(workspaceId, 'mcpServers', async () => (await capabilities).servers),
    runSource(workspaceId, 'mcpTools', async () => (await capabilities).tools),
    runSource(workspaceId, 'skills', async () => (await capabilities).skills),
    runSource(workspaceId, 'agents', () => loadAgents(workspaceId))
  ]);
  const runtimePolicy = effectiveWorkflowRuntimePolicy();
  const runtimeLabel = runtimePolicy.maxRuntimeSeconds % 60 === 0
    ? `${runtimePolicy.maxRuntimeSeconds / 60} minutes (deployment limit)`
    : `${runtimePolicy.maxRuntimeSeconds} seconds (deployment limit)`;
  return {
    mcpServers: mcpServers.options,
    mcpTools: mcpTools.options,
    skills: skills.options,
    agents: agents.options,
    outputFormats: [
      { value: 'pdf', label: 'PDF' },
      { value: 'markdown', label: 'Markdown' }
    ],
    approvalPolicies: [
      { value: 'read_only', label: 'Read only' },
      { value: 'read_write', label: 'Read/write with approvals' }
    ],
    runtimeLimits: [{ value: String(runtimePolicy.maxRuntimeSeconds), label: runtimeLabel }],
    retentionPolicies: [{
      value: String(runtimePolicy.retentionDays),
      label: `${runtimePolicy.retentionDays} days (deployment limit)`
    }],
    sourceAvailability: {
      mcpServers: mcpServers.availability,
      mcpTools: mcpTools.availability,
      skills: skills.availability,
      agents: agents.availability
    }
  };
}
