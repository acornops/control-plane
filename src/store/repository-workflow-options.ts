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
import type { AgentDefinition } from '../types/agents.js';
import { defaultAgentDefinitions } from './repository-agents.js';
import { listWorkflowMcpServers } from './repository-workflow-mcp.js';
import { defaultWorkflowDefinitions } from './repository-workflow-defaults.js';

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
  name: string;
  status: string;
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

const canonicalSharedSkills = [
  { id: 'acornops-observability', name: 'AcornOps observability', description: 'Incident and signal analysis' },
  { id: 'acornops-cross-repo-change', name: 'Cross-repo change', description: 'Multi-repository coordination' },
  { id: 'acornops-open-pr', name: 'Open PR', description: 'Prepare branch and pull request handoff' },
  { id: 'acornops-target-boundary-design', name: 'Target boundary design', description: 'Target model compatibility checks' }
];

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

async function seedAgents(workspaceId: string): Promise<void> {
  for (const agent of defaultAgentDefinitions(workspaceId)) {
    await persistAgentDefinition(agent, false);
  }
}

export async function persistAgentDefinition(agent: AgentDefinition, updateExisting = true): Promise<void> {
  if (catalogLoaderOverride) return;
  await db.query(
    `INSERT INTO agent_definitions (
         workspace_id, id, name, description, instructions, status, source, kind,
         provider_type, version, owner_user_id, created_by, mcp_servers, tools,
         skills, context_grants, target_scope, approval_policy, trust_policy,
         run_count, last_run_at, last_status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
         $18::jsonb, $19::jsonb, $20, $21, $22, $23, $24
       ) ON CONFLICT (workspace_id, id) ${updateExisting ? `DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         instructions = EXCLUDED.instructions,
         status = EXCLUDED.status,
         provider_type = EXCLUDED.provider_type,
         version = EXCLUDED.version,
         owner_user_id = EXCLUDED.owner_user_id,
         mcp_servers = EXCLUDED.mcp_servers,
         tools = EXCLUDED.tools,
         skills = EXCLUDED.skills,
         context_grants = EXCLUDED.context_grants,
         target_scope = EXCLUDED.target_scope,
         approval_policy = EXCLUDED.approval_policy,
         trust_policy = EXCLUDED.trust_policy,
         run_count = EXCLUDED.run_count,
         last_run_at = EXCLUDED.last_run_at,
         last_status = EXCLUDED.last_status,
         updated_at = EXCLUDED.updated_at` : 'DO NOTHING'}`,
    [
        agent.workspaceId, agent.id, agent.name, agent.description || null, agent.instructions,
        agent.status, agent.source, agent.kind, agent.providerType, agent.version,
        agent.ownerUserId, agent.createdBy, JSON.stringify(agent.mcpServers),
        JSON.stringify(agent.tools), JSON.stringify(agent.skills), JSON.stringify(agent.contextGrants),
        JSON.stringify(agent.targetScope), JSON.stringify(agent.approvalPolicy), JSON.stringify(agent.trustPolicy),
        agent.activity.runCount, agent.activity.lastRunAt || null, agent.activity.lastStatus || null,
        agent.createdAt, agent.updatedAt
    ]
  );
}

export async function deletePersistedAgentDefinition(workspaceId: string, agentId: string): Promise<void> {
  if (catalogLoaderOverride) return;
  await db.query('DELETE FROM agent_definitions WHERE workspace_id = $1 AND id = $2', [workspaceId, agentId]);
}

async function seedSharedSkills(workspaceId: string): Promise<void> {
  for (const skill of canonicalSharedSkills) {
    await db.query(
      `INSERT INTO workspace_skills (
         workspace_id, id, name, description, source, enabled, validation_status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'system', true, 'valid', NOW(), NOW())
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [workspaceId, skill.id, skill.name, skill.description]
    );
  }
}

async function seedWorkflows(workspaceId: string): Promise<void> {
  for (const workflow of defaultWorkflowDefinitions(workspaceId)) {
    await db.query(
      `INSERT INTO workflow_definitions (
         workspace_id, id, version, source, template_id, name, description, status,
         category, orchestrator_agent_id, tags, inputs, enabled_mcp_servers,
         enabled_skills, required_permissions, policy, steps, starter_prompt,
         created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
         $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18,
         'system', NOW(), NOW()
       ) ON CONFLICT (workspace_id, id) DO NOTHING`,
      [
        workspaceId, workflow.id, workflow.version, workflow.source || 'system', workflow.templateId || null,
        workflow.name, workflow.description || null, workflow.status || 'active', workflow.category,
        workflow.orchestratorAgentId, JSON.stringify(workflow.tags || []), JSON.stringify(workflow.inputs || []),
        JSON.stringify(workflow.enabledMcpServers || []), JSON.stringify(workflow.enabledSkills || []),
        JSON.stringify(workflow.requiredPermissions), JSON.stringify(workflow.policy), JSON.stringify(workflow.steps),
        workflow.starterPrompt || null
      ]
    );
  }
}

async function loadClusters(workspaceId: string): Promise<CatalogSourceResult> {
  const result = await db.query<TargetRow>(
    `SELECT id, name, status
     FROM targets
     WHERE workspace_id = $1 AND target_type = 'kubernetes'
     ORDER BY name ASC, id ASC`,
    [workspaceId]
  );
  const options = result.rows.map((row) => ({
    value: row.id,
    label: row.name,
    description: `Kubernetes cluster · ${row.status}`,
    disabled: row.status === 'offline',
    disabledReason: row.status === 'offline' ? 'Cluster is offline' : undefined,
    provenance: { source: 'target' as const, targetId: row.id, targetName: row.name }
  }));
  return { options, availability: availability(options, 'No Kubernetes clusters are registered.') };
}

async function loadMcp(workspaceId: string): Promise<{ servers: CatalogSourceResult; tools: CatalogSourceResult }> {
  const servers = await listWorkflowMcpServers(workspaceId);
  const serverOptions = servers.map((row) => ({
    value: row.id,
    label: row.name,
    description: row.status,
    disabled: !row.enabled || row.status !== 'connected',
    disabledReason: !row.enabled ? 'Server disabled' : row.status !== 'connected' ? 'MCP server is not connected' : undefined,
    provenance: { source: 'workspace' as const }
  }));
  const toolOptions = servers.flatMap((server) => server.tools.map((tool) => ({
    value: tool.name,
    label: tool.title || tool.name,
    description: `${server.name} · ${tool.capability}`,
    disabled: !server.enabled || server.status !== 'connected' || tool.enabled === false,
    disabledReason: !server.enabled ? 'MCP server disabled' : server.status !== 'connected' ? 'MCP server is not connected' : tool.enabled === false ? 'Tool disabled' : undefined,
    provenance: { source: 'workspace' as const }
  })));
  return {
    servers: { options: serverOptions, availability: availability(serverOptions, 'No MCP servers are configured.') },
    tools: { options: toolOptions, availability: availability(toolOptions, 'No MCP tools are available.') }
  };
}

async function loadSkills(workspaceId: string): Promise<CatalogSourceResult> {
  await seedSharedSkills(workspaceId);
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
  await seedAgents(workspaceId);
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

async function seedSystemWorkflows(workspaceId: string): Promise<void> {
  const startedAt = performance.now();
  try {
    await seedWorkflows(workspaceId);
    logger.info({ workspaceId, source: 'systemWorkflows', outcome: 'available', latencyMs: Math.round(performance.now() - startedAt) }, 'Seeded workflow system definitions');
  } catch (error) {
    logger.warn({
      workspaceId,
      source: 'systemWorkflows',
      outcome: 'error',
      latencyMs: Math.round(performance.now() - startedAt),
      errorCode: safeErrorCode(error)
    }, 'Failed seeding workflow system definitions');
  }
}

export async function getWorkflowOptionsCatalog(workspaceId: string): Promise<WorkflowOptionsCatalog> {
  if (catalogLoaderOverride) return catalogLoaderOverride(workspaceId);
  const [clusters, mcpServers, mcpTools, skills, agents, chatSessions] = await Promise.all([
    runSource(workspaceId, 'clusters', () => loadClusters(workspaceId)),
    runSource(workspaceId, 'mcpServers', async () => (await loadMcp(workspaceId)).servers),
    runSource(workspaceId, 'mcpTools', async () => (await loadMcp(workspaceId)).tools),
    runSource(workspaceId, 'skills', () => loadSkills(workspaceId)),
    runSource(workspaceId, 'agents', () => loadAgents(workspaceId)),
    runSource(workspaceId, 'chatSessions', () => loadChatSessions(workspaceId))
  ]);
  await seedSystemWorkflows(workspaceId);

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
