import { performance } from 'node:perf_hooks';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementWorkflowCatalogSource } from '../metrics.js';
import { loadWorkflowBuiltInMcpCatalog } from '../services/workflow-built-in-mcp-catalog.js';
import { KUBERNETES_TARGET_TYPE, type TargetSummary } from '../types/domain.js';
import type {
  WorkflowCatalogSourceAvailability,
  WorkflowCatalogSourceName,
  WorkflowOption,
  WorkflowOptionsCatalog
} from '../types/workflows.js';
import { listWorkflowMcpServers } from './repository-workflow-mcp.js';

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

interface TargetRow {
  id: string;
  workspace_id: string;
  target_type: 'kubernetes';
  name: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  source_kind: 'workspace' | 'target';
  target_id: string | null;
  target_name: string | null;
  source_provider: 'github' | 'gitlab' | null;
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

interface SessionRow {
  id: string;
  title: string;
  target_id: string;
  target_name: string;
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

async function loadClusters(workspaceId: string): Promise<CatalogSourceResult> {
  const result = await db.query<TargetRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE workspace_id = $1 AND target_type = 'kubernetes'
     ORDER BY name ASC, id ASC`,
    [workspaceId]
  );
  const options = result.rows.map((row) => ({
    value: row.id,
    label: row.name,
    description: `Kubernetes cluster · ${row.status}`,
    disabled: row.status === 'offline' || row.status === 'unknown',
    disabledReason: row.status === 'offline'
      ? 'Cluster is offline'
      : row.status === 'unknown' ? 'Cluster connection is not ready' : undefined,
    provenance: { source: 'target' as const, targetId: row.id, targetName: row.name }
  }));
  return { options, availability: availability(options, 'No Kubernetes clusters are registered.') };
}

async function loadMcp(workspaceId: string): Promise<{ servers: CatalogSourceResult; tools: CatalogSourceResult }> {
  const result = await db.query<TargetRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE workspace_id = $1 AND target_type = 'kubernetes'
     ORDER BY name ASC, id ASC`,
    [workspaceId]
  );
  const targets: TargetSummary[] = result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    targetType: KUBERNETES_TARGET_TYPE,
    name: row.name,
    status: row.status as TargetSummary['status'],
    metadata: row.metadata || {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }));
  const [catalog, workspaceServers] = await Promise.all([
    loadWorkflowBuiltInMcpCatalog(workspaceId, targets),
    listWorkflowMcpServers(workspaceId)
  ]);
  const clusterCount = catalog.server.targetIds.length;
  const serverOptions: WorkflowOption[] = [{
    value: catalog.server.id,
    label: catalog.server.name,
    description: `System-owned Kubernetes tools · ${clusterCount} available ${clusterCount === 1 ? 'cluster' : 'clusters'}`,
    disabled: !catalog.server.enabled,
    disabledReason: !catalog.server.enabled ? 'No registered Kubernetes cluster exposes the built-in server' : undefined,
    provenance: { source: 'target' as const }
  }, ...workspaceServers.map((server) => ({
    value: server.id,
    label: server.name,
    description: 'User-configured workspace MCP server',
    disabled: !server.enabled || server.status !== 'connected',
    disabledReason: !server.enabled
      ? 'MCP server disabled'
      : server.status !== 'connected' ? 'MCP server is not connected' : undefined,
    provenance: { source: 'workspace' as const }
  }))];
  const builtInToolOptions: WorkflowOption[] = catalog.tools.map((tool) => ({
    value: tool.name,
    label: tool.name,
    description: `${catalog.server.name} · ${tool.capability}`,
    disabled: !tool.enabled,
    disabledReason: !tool.enabled ? 'Built-in tool is disabled on every Kubernetes cluster' : undefined,
    provenance: { source: 'target' as const }
  }));
  const internalToolOptions: WorkflowOption[] = [
    {
      value: 'chat.sessions.read_selected',
      label: 'Read selected chats',
      description: 'AcornOps built-in workflow tool · read',
      provenance: { source: 'workspace' as const }
    },
    {
      value: 'reports.pdf.generate',
      label: 'Generate incident report PDF',
      description: 'AcornOps built-in workflow tool · write',
      provenance: { source: 'workspace' as const }
    }
  ];
  const workspaceToolOptions: WorkflowOption[] = workspaceServers.flatMap((server) => server.tools.map((tool) => ({
    value: tool.name,
    label: tool.title || tool.name,
    description: `${server.name} · ${tool.capability}`,
    disabled: !server.enabled || server.status !== 'connected' || tool.enabled === false,
    disabledReason: !server.enabled
      ? 'MCP server disabled'
      : server.status !== 'connected' ? 'MCP server is not connected' : tool.enabled === false ? 'Tool disabled' : undefined,
    provenance: { source: 'workspace' as const }
  })));
  const toolOptions = [...new Map(
    [...builtInToolOptions, ...internalToolOptions, ...workspaceToolOptions]
      .map((option) => [option.value, option])
  ).values()];
  return {
    servers: { options: serverOptions, availability: availability(serverOptions, 'The built-in Kubernetes MCP server is unavailable.') },
    tools: { options: toolOptions, availability: availability(toolOptions, 'No built-in Kubernetes tools are available.') }
  };
}

async function loadSkills(workspaceId: string): Promise<CatalogSourceResult> {
  const result = await db.query<SkillRow>(
    `SELECT skill.id, skill.name, skill.description, skill.source_kind,
            skill.target_id, skill.target_name, skill.source_provider
     FROM (
       SELECT ws.id, ws.name, ws.description, 'workspace'::text AS source_kind,
              NULL::text AS target_id, NULL::text AS target_name, NULL::text AS source_provider
       FROM workspace_skills ws
       WHERE ws.workspace_id = $1 AND ws.enabled = true AND ws.validation_status = 'valid'
       UNION ALL
       SELECT ts.id, ts.name, ts.description, 'target'::text AS source_kind,
              ts.target_id, target.name AS target_name, ts.source_provider
       FROM target_skills ts
       JOIN targets target ON target.id = ts.target_id AND target.workspace_id = ts.workspace_id
       WHERE ts.workspace_id = $1 AND ts.enabled = true AND ts.validation_status = 'valid'
     ) skill
     ORDER BY skill.name ASC, skill.id ASC`,
    [workspaceId]
  );
  const options = result.rows.map((row) => ({
    value: row.source_kind === 'target' ? `target:${row.target_id}:${row.id}` : row.id,
    label: row.name,
    description: row.source_kind === 'target' && row.target_name
      ? `${row.description} · ${row.target_name}`
      : row.description,
    provenance: row.source_kind === 'target'
      ? { source: 'target' as const, targetId: row.target_id || undefined, targetName: row.target_name || undefined, provider: row.source_provider || undefined }
      : { source: 'workspace' as const }
  }));
  return { options, availability: availability(options, 'No enabled, valid skills are available.') };
}

async function loadAgents(workspaceId: string): Promise<CatalogSourceResult> {
  const result = await db.query<AgentRow>(
    `SELECT id, name, description, status
     FROM agent_definitions
     WHERE workspace_id = $1 AND kind = 'specialist_agent'
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

async function loadChatSessions(workspaceId: string): Promise<CatalogSourceResult> {
  const result = await db.query<SessionRow>(
    `SELECT session.id, session.title, session.target_id, target.name AS target_name
     FROM sessions session
     JOIN targets target ON target.id = session.target_id AND target.workspace_id = session.workspace_id
     WHERE session.workspace_id = $1
       AND session.status = 'open'
       AND session.deleted_at IS NULL
       AND session.expires_at > NOW()
     ORDER BY session.last_message_at DESC, session.id DESC`,
    [workspaceId]
  );
  const options = result.rows.map((row) => ({
    value: row.id,
    label: row.title,
    description: row.target_name,
    provenance: { source: 'target' as const, targetId: row.target_id, targetName: row.target_name }
  }));
  return { options, availability: availability(options, 'No active chat sessions are available.') };
}

export async function getWorkflowOptionsCatalog(workspaceId: string): Promise<WorkflowOptionsCatalog> {
  if (catalogLoaderOverride) return catalogLoaderOverride(workspaceId);
  const mcp = loadMcp(workspaceId);
  const [clusters, mcpServers, mcpTools, skills, agents, chatSessions] = await Promise.all([
    runSource(workspaceId, 'clusters', () => loadClusters(workspaceId)),
    runSource(workspaceId, 'mcpServers', async () => (await mcp).servers),
    runSource(workspaceId, 'mcpTools', async () => (await mcp).tools),
    runSource(workspaceId, 'skills', () => loadSkills(workspaceId)),
    runSource(workspaceId, 'agents', () => loadAgents(workspaceId)),
    runSource(workspaceId, 'chatSessions', () => loadChatSessions(workspaceId))
  ]);
  return {
    clusters: clusters.options,
    mcpServers: mcpServers.options,
    mcpTools: mcpTools.options,
    skills: skills.options,
    agents: agents.options,
    chatSessions: chatSessions.options,
    outputFormats: [
      { value: 'pdf', label: 'PDF' },
      { value: 'markdown', label: 'Markdown' }
    ],
    approvalPolicies: [
      { value: 'read_only', label: 'Read only' },
      { value: 'read_write', label: 'Read/write with approvals' }
    ],
    runtimeLimits: [
      { value: '300', label: '5 minutes' },
      { value: '900', label: '15 minutes' },
      { value: '1800', label: '30 minutes' }
    ],
    retentionPolicies: [
      { value: '30', label: '30 days' },
      { value: '90', label: '90 days' },
      { value: '180', label: '180 days' }
    ],
    sourceAvailability: {
      clusters: clusters.availability,
      mcpServers: mcpServers.availability,
      mcpTools: mcpTools.availability,
      skills: skills.availability,
      agents: agents.availability,
      chatSessions: chatSessions.availability
    }
  };
}
