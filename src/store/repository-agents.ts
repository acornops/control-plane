import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { incrementAutomationMcpFailure } from '../metrics.js';
import type {
  AgentDefinition,
  AgentTriggerDefinition,
  AgentTriggerType,
  AgentVersionSnapshot
} from '../types/agents.js';
import { listWorkflowMcpServers } from './repository-workflow-mcp.js';
import { computeNextWorkflowScheduleRunAt } from './repository-workflow-schedules.js';

export {
  appendAgentRunEvents,
  createAgentRunActivity,
  getAgentActivityRecord,
  listAgentActivityRecords,
  listAgentRunEvents,
  updateAgentActivityRecord
} from './repository-agent-activity.js';

const defaultDevelopmentOwnerUserId = 'user-1';

export interface CreateAgentDefinitionInput {
  workspaceId: string;
  name: string;
  description?: string;
  instructions: string;
  ownerUserId: string;
  createdBy: string;
  kind?: AgentDefinition['kind'];
  providerType?: AgentDefinition['providerType'];
  mcpServers?: string[];
  tools?: string[];
  skills?: string[];
  contextGrants?: string[];
  approvalPolicy?: AgentDefinition['approvalPolicy'];
  trustPolicy?: AgentDefinition['trustPolicy'];
  targetScope?: AgentDefinition['targetScope'];
}

export interface AgentDefinitionUpdate {
  name?: string;
  description?: string;
  instructions?: string;
  status?: AgentDefinition['status'];
  kind?: AgentDefinition['kind'];
  providerType?: AgentDefinition['providerType'];
  ownerUserId?: string;
  mcpServers?: string[];
  tools?: string[];
  skills?: string[];
  contextGrants?: string[];
  approvalPolicy?: AgentDefinition['approvalPolicy'];
  trustPolicy?: AgentDefinition['trustPolicy'];
  targetScope?: AgentDefinition['targetScope'];
}

export interface CreateAgentTriggerInput {
  type: AgentTriggerType;
  enabled?: boolean;
  name?: string;
  schedule?: AgentTriggerDefinition['schedule'];
  eventFilter?: Record<string, unknown>;
  secretCiphertext?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueSorted(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function slug(value: string, fallback: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || fallback;
}

function cloneAgent(agent: AgentDefinition): AgentDefinition {
  return {
    ...agent,
    mcpServers: [...agent.mcpServers],
    tools: [...agent.tools],
    skills: [...agent.skills],
    contextGrants: [...agent.contextGrants],
    targetScope: {
      type: agent.targetScope.type,
      ...(agent.targetScope.targetTypes ? { targetTypes: [...agent.targetScope.targetTypes] } : {}),
      ...(agent.targetScope.targetIds ? { targetIds: [...agent.targetScope.targetIds] } : {})
    },
    approvalPolicy: { ...agent.approvalPolicy },
    trustPolicy: { ...agent.trustPolicy },
    triggers: agent.triggers.map((trigger) => ({
      ...trigger,
      schedule: trigger.schedule ? { ...trigger.schedule } : undefined,
      eventFilter: trigger.eventFilter ? { ...trigger.eventFilter } : undefined
    })),
    activity: { ...agent.activity },
    readiness: { status: agent.readiness.status, reasons: [...agent.readiness.reasons] }
  };
}

function cloneVersion(version: AgentVersionSnapshot): AgentVersionSnapshot {
  return {
    ...version,
    snapshot: cloneAgent(version.snapshot)
  };
}

export function defaultAgentDefinitions(workspaceId: string): AgentDefinition[] {
  const now = nowIso();
  return [
    {
      id: 'agent-workflow-orchestrator',
      workspaceId,
      name: 'System Orchestrator',
      description: 'Coordinates workflow steps and applies server-compiled workflow capability gates.',
      instructions: 'Coordinate workflow execution using the workflow definition and selected agents. Do not grant additional domain tool access.',
      status: 'active',
      source: 'system',
      kind: 'system_orchestrator',
      providerType: 'internal',
      version: 1,
      ownerUserId: 'system',
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      mcpServers: [],
      tools: [],
      skills: [],
      contextGrants: [],
      targetScope: { type: 'workspace' },
      approvalPolicy: { mode: 'none', writeToolsRequireApproval: true },
      trustPolicy: { level: 'restricted', allowExternalData: false },
      triggers: [],
      activity: { runCount: 0 },
      readiness: { status: 'ready', reasons: [] }
    },
    {
      id: 'agent-cluster-triage',
      workspaceId,
      name: 'Kubernetes Diagnostics',
      description: 'Collects live Kubernetes inventory, resource details, and logs through AgentK.',
      instructions: 'Use only the selected target and the read-only built-in AgentK tools.',
      status: 'active',
      source: 'system',
      kind: 'specialist_agent',
      providerType: 'internal',
      version: 2,
      ownerUserId: defaultDevelopmentOwnerUserId,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      mcpServers: ['acornops-target-agent'],
      tools: ['get_resource', 'get_resource_logs', 'list_resources'],
      skills: ['acornops-observability', 'acornops-target-boundary-design'],
      contextGrants: ['target_inventory', 'workspace_metadata'],
      targetScope: { type: 'selected_target', targetTypes: ['kubernetes'] },
      approvalPolicy: { mode: 'none', writeToolsRequireApproval: true },
      trustPolicy: { level: 'restricted', allowExternalData: false },
      triggers: [],
      activity: { runCount: 0 },
      readiness: { status: 'needs_setup', reasons: ['Select an online Kubernetes target with the built-in AcornOps Target Tools server.'] }
    },
    {
      id: 'agent-release-coordinator',
      workspaceId,
      name: 'Repository Operator',
      description: 'Reads repository context and prepares release handoff notes.',
      instructions: 'Coordinate release checks; request approval before write tools.',
      status: 'active',
      source: 'system',
      kind: 'specialist_agent',
      providerType: 'external',
      version: 2,
      ownerUserId: defaultDevelopmentOwnerUserId,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      mcpServers: [],
      tools: [],
      skills: ['acornops-cross-repo-change', 'acornops-open-pr'],
      contextGrants: ['workspace_metadata'],
      targetScope: { type: 'workspace' },
      approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
      trustPolicy: { level: 'restricted', allowExternalData: false },
      triggers: [],
      activity: { runCount: 0 },
      readiness: { status: 'needs_setup', reasons: ['Add and assign a GitHub or GitLab MCP integration.'] }
    },
    {
      id: 'agent-incident-reporter',
      workspaceId,
      name: 'Incident Reporter',
      description: 'Reads selected incident chats and produces report artifacts.',
      instructions: 'Use selected chat context only after approval and write the requested report artifact.',
      status: 'active',
      source: 'system',
      kind: 'specialist_agent',
      providerType: 'internal',
      version: 2,
      ownerUserId: defaultDevelopmentOwnerUserId,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      mcpServers: [],
      tools: ['chat.sessions.read_selected', 'reports.pdf.generate'],
      skills: ['acornops-observability'],
      contextGrants: ['selected_chat_sessions'],
      targetScope: { type: 'workspace' },
      approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
      trustPolicy: { level: 'restricted', allowExternalData: false },
      triggers: [],
      activity: { runCount: 0 },
      readiness: { status: 'ready', reasons: [] }
    }
  ];
}

type AgentRow = QueryResultRow;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapTrigger(row: AgentRow): AgentTriggerDefinition {
  return { id: row.id, type: row.type, enabled: row.enabled, name: row.name || undefined,
    schedule: row.schedule || undefined, eventFilter: row.event_filter || undefined,
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at) };
}

async function triggersFor(workspaceId: string, agentId: string): Promise<AgentTriggerDefinition[]> {
  const result = await db.query<AgentRow>(
    'SELECT * FROM agent_triggers WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at,id', [workspaceId, agentId]
  );
  return result.rows.map(mapTrigger);
}

async function mapAgent(row: AgentRow): Promise<AgentDefinition> {
  const agent: AgentDefinition = {
    id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description || undefined,
    instructions: row.instructions, status: row.status, source: row.source, kind: row.kind,
    providerType: row.provider_type, version: row.version, ownerUserId: row.owner_user_id,
    createdBy: row.created_by, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    mcpServers: row.mcp_servers || [], tools: row.tools || [], skills: row.skills || [],
    contextGrants: row.context_grants || [], targetScope: row.target_scope,
    approvalPolicy: row.approval_policy, trustPolicy: row.trust_policy,
    triggers: await triggersFor(row.workspace_id, row.id),
    activity: { runCount: row.run_count || 0, lastRunAt: iso(row.last_run_at), lastStatus: row.last_status || undefined },
    readiness: { status: row.readiness_status || 'needs_setup', reasons: row.readiness_reasons || [] }
  };
  if (agent.source !== 'system') return agent;
  if (agent.id === 'agent-cluster-triage') {
    const targets = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM targets
       WHERE workspace_id=$1 AND target_type='kubernetes' AND status IN ('online', 'degraded')`,
      [agent.workspaceId]
    );
    agent.readiness = Number(targets.rows[0]?.count || 0) > 0
      ? { status: 'ready', reasons: [] }
      : { status: 'needs_setup', reasons: ['Select an online Kubernetes target with the built-in AcornOps Target Tools server.'] };
  }
  if (agent.id === 'agent-release-coordinator') {
    const required = new Map<string, 'read' | 'write'>([
      ['repository.metadata.read', 'read'],
      ['repository.tree.list', 'read'],
      ['repository.file.read', 'read'],
      ['repository.branch.create', 'write'],
      ['repository.commit.create', 'write'],
      ['repository.change_request.create', 'write']
    ]);
    try {
      const servers = await listWorkflowMcpServers(agent.workspaceId);
      const server = servers.find((candidate) => {
        if (!candidate.enabled || candidate.status !== 'connected' || !candidate.credentialConfigured) return false;
        const tools = new Map(candidate.tools.filter((tool) => tool.enabled).map((tool) => [tool.name, tool.capability]));
        return [...required].every(([name, capability]) => tools.get(name) === capability);
      });
      if (server) {
        agent.mcpServers = [server.id];
        agent.tools = [...required.keys()];
        agent.readiness = { status: 'ready', reasons: [] };
      } else {
        agent.readiness = {
          status: 'needs_setup',
          reasons: ['Configure a connected, credentialed repository MCP server with the canonical read and idempotent write tools.']
        };
      }
    } catch {
      incrementAutomationMcpFailure('repository_readiness');
      agent.readiness = {
        status: 'blocked',
        reasons: ['Repository MCP readiness could not be verified. Check the automation dependency diagnostics.']
      };
    }
  }
  return agent;
}

export async function listAgentDefinitions(workspaceId: string, options: { includeInactive?: boolean } = {}): Promise<AgentDefinition[]> {
  const result = await db.query<AgentRow>(
    `SELECT * FROM agent_definitions WHERE workspace_id=$1 ${options.includeInactive ? '' : "AND status='active'"} ORDER BY updated_at DESC,id`,
    [workspaceId]
  );
  return Promise.all(result.rows.map(mapAgent));
}

export async function getAgentDefinition(workspaceId: string, agentId: string): Promise<AgentDefinition | null> {
  const result = await db.query<AgentRow>('SELECT * FROM agent_definitions WHERE workspace_id=$1 AND id=$2', [workspaceId, agentId]);
  return result.rowCount ? mapAgent(result.rows[0]) : null;
}

export async function deleteAgentDefinition(workspaceId: string, agentId: string): Promise<boolean> {
  const result = await db.query("DELETE FROM agent_definitions WHERE workspace_id=$1 AND id=$2 AND source='user'", [workspaceId, agentId]);
  return Boolean(result.rowCount);
}

export async function createAgentDefinition(input: CreateAgentDefinitionInput): Promise<AgentDefinition> {
  const id = `agent-${slug(input.name, 'custom')}-${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  const agent: AgentDefinition = {
    id,
    workspaceId: input.workspaceId,
    name: input.name.trim(),
    description: input.description?.trim(),
    instructions: input.instructions.trim(),
    status: 'active',
    source: 'user',
    kind: input.kind || 'specialist_agent',
    providerType: input.providerType || 'internal',
    version: 1,
    ownerUserId: input.ownerUserId,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    mcpServers: uniqueSorted(input.mcpServers),
    tools: uniqueSorted(input.tools),
    skills: uniqueSorted(input.skills),
    contextGrants: uniqueSorted(input.contextGrants),
    targetScope: input.targetScope || { type: 'workspace' },
    approvalPolicy: input.approvalPolicy || { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: input.trustPolicy || { level: 'restricted', allowExternalData: false },
    triggers: [],
    activity: { runCount: 0 },
    readiness: { status: 'ready', reasons: [] }
  };
  const result = await db.query<AgentRow>(
    `INSERT INTO agent_definitions (
      workspace_id,id,name,description,instructions,status,source,kind,provider_type,version,owner_user_id,created_by,
      mcp_servers,tools,skills,context_grants,target_scope,approval_policy,trust_policy,readiness_status,readiness_reasons
     ) VALUES ($1,$2,$3,$4,$5,'active','user',$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ready','[]') RETURNING *`,
    [input.workspaceId, id, agent.name, agent.description || null, agent.instructions, agent.kind, agent.providerType,
     agent.ownerUserId, agent.createdBy, JSON.stringify(agent.mcpServers), JSON.stringify(agent.tools), JSON.stringify(agent.skills), JSON.stringify(agent.contextGrants),
     agent.targetScope, agent.approvalPolicy, agent.trustPolicy]
  );
  return mapAgent(result.rows[0]);
}

export async function updateAgentDefinition(workspaceId: string, agentId: string, patch: AgentDefinitionUpdate): Promise<AgentDefinition | null> {
  const current = await getAgentDefinition(workspaceId, agentId);
  if (!current) return null;
  const updated: AgentDefinition = {
    ...current,
    name: patch.name?.trim() || current.name,
    description: typeof patch.description === 'string' ? patch.description.trim() : current.description,
    instructions: patch.instructions?.trim() || current.instructions,
    status: patch.status || current.status,
    kind: patch.kind || current.kind,
    providerType: patch.providerType || current.providerType,
    ownerUserId: patch.ownerUserId || current.ownerUserId,
    mcpServers: patch.mcpServers ? uniqueSorted(patch.mcpServers) : current.mcpServers,
    tools: patch.tools ? uniqueSorted(patch.tools) : current.tools,
    skills: patch.skills ? uniqueSorted(patch.skills) : current.skills,
    contextGrants: patch.contextGrants ? uniqueSorted(patch.contextGrants) : current.contextGrants,
    targetScope: patch.targetScope || current.targetScope,
    approvalPolicy: patch.approvalPolicy || current.approvalPolicy,
    trustPolicy: patch.trustPolicy || current.trustPolicy,
    version: current.version + 1,
    updatedAt: nowIso()
  };
  const result = await db.query<AgentRow>(
    `UPDATE agent_definitions SET name=$3,description=$4,instructions=$5,status=$6,kind=$7,provider_type=$8,
      owner_user_id=$9,mcp_servers=$10,tools=$11,skills=$12,context_grants=$13,target_scope=$14,
      approval_policy=$15,trust_policy=$16,version=version+1,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, agentId, updated.name, updated.description || null, updated.instructions, updated.status, updated.kind,
     updated.providerType, updated.ownerUserId, JSON.stringify(updated.mcpServers), JSON.stringify(updated.tools), JSON.stringify(updated.skills),
     JSON.stringify(updated.contextGrants), updated.targetScope, updated.approvalPolicy, updated.trustPolicy]
  );
  return result.rowCount ? mapAgent(result.rows[0]) : null;
}

export async function createAgentVersionSnapshot(workspaceId: string, agentId: string, createdBy: string): Promise<AgentVersionSnapshot | null> {
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) return null;
  const version: AgentVersionSnapshot = {
    id: randomUUID(),
    agentId,
    workspaceId,
    version: agent.version,
    snapshot: cloneAgent(agent),
    createdBy,
    createdAt: nowIso()
  };
  await db.query(
    'INSERT INTO agent_versions (workspace_id,agent_id,id,version,snapshot,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [workspaceId, agentId, version.id, version.version, version.snapshot, createdBy, version.createdAt]
  );
  return version;
}

export async function listAgentVersionSnapshots(workspaceId: string, agentId: string): Promise<AgentVersionSnapshot[]> {
  const result = await db.query<AgentRow>(
    'SELECT * FROM agent_versions WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id DESC', [workspaceId, agentId]
  );
  return result.rows.map((row) => ({ id: row.id, agentId: row.agent_id, workspaceId: row.workspace_id,
    version: row.version, snapshot: row.snapshot, createdBy: row.created_by, createdAt: iso(row.created_at)! }));
}

export async function restoreAgentVersionSnapshot(workspaceId: string, agentId: string, versionId: string): Promise<AgentDefinition | null> {
  const current = await getAgentDefinition(workspaceId, agentId);
  if (!current) return null;
  const result = await db.query<AgentRow>('SELECT snapshot FROM agent_versions WHERE workspace_id=$1 AND agent_id=$2 AND id=$3', [workspaceId, agentId, versionId]);
  if (!result.rowCount) return null;
  const restored: AgentDefinition = {
    ...result.rows[0].snapshot,
    id: current.id,
    workspaceId,
    version: current.version + 1,
    updatedAt: nowIso()
  };
  return updateAgentDefinition(workspaceId, agentId, restored);
}

export async function createAgentTrigger(workspaceId: string, agentId: string, input: CreateAgentTriggerInput): Promise<AgentTriggerDefinition | null> {
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) return null;
  const now = nowIso();
  const trigger: AgentTriggerDefinition = {
    id: randomUUID(),
    type: input.type,
    enabled: input.enabled !== false,
    name: input.name?.trim(),
    schedule: input.schedule ? { ...input.schedule } : undefined,
    eventFilter: input.eventFilter ? { ...input.eventFilter } : undefined,
    createdAt: now,
    updatedAt: now
  };
  const nextOccurrenceAt = trigger.type === 'schedule' && trigger.schedule
    ? computeNextWorkflowScheduleRunAt(trigger.schedule.cron, new Date(), trigger.schedule.timezone)
    : null;
  const result = await db.query<AgentRow>(
    `INSERT INTO agent_triggers (workspace_id,agent_id,id,type,enabled,name,schedule,event_filter,secret_ciphertext,next_occurrence_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
    [workspaceId, agentId, trigger.id, trigger.type, trigger.enabled, trigger.name || null,
     trigger.schedule || null, trigger.eventFilter || null, input.secretCiphertext || null, nextOccurrenceAt, now]
  );
  await db.query('UPDATE agent_definitions SET version=version+1,updated_at=NOW() WHERE workspace_id=$1 AND id=$2', [workspaceId, agentId]);
  return mapTrigger(result.rows[0]);
}

export async function updateAgentTrigger(
  workspaceId: string,
  agentId: string,
  triggerId: string,
  patch: Partial<CreateAgentTriggerInput>
): Promise<AgentTriggerDefinition | null> {
  const agent = await getAgentDefinition(workspaceId, agentId);
  const trigger = agent?.triggers.find((candidate) => candidate.id === triggerId);
  if (!trigger) return null;
  const updatedTrigger: AgentTriggerDefinition = {
    ...trigger,
    type: patch.type || trigger.type,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : trigger.enabled,
    name: typeof patch.name === 'string' ? patch.name.trim() : trigger.name,
    schedule: patch.schedule ? { ...patch.schedule } : trigger.schedule,
    eventFilter: patch.eventFilter ? { ...patch.eventFilter } : trigger.eventFilter,
    updatedAt: nowIso()
  };
  const nextOccurrenceAt = updatedTrigger.type === 'schedule' && updatedTrigger.enabled && updatedTrigger.schedule
    ? computeNextWorkflowScheduleRunAt(updatedTrigger.schedule.cron, new Date(), updatedTrigger.schedule.timezone)
    : null;
  const result = await db.query<AgentRow>(
    `UPDATE agent_triggers SET type=$4,enabled=$5,name=$6,schedule=$7,event_filter=$8,next_occurrence_at=$9,updated_at=NOW()
     WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 RETURNING *`,
    [workspaceId, agentId, triggerId, updatedTrigger.type, updatedTrigger.enabled, updatedTrigger.name || null,
     updatedTrigger.schedule || null, updatedTrigger.eventFilter || null, nextOccurrenceAt]
  );
  await db.query('UPDATE agent_definitions SET version=version+1,updated_at=NOW() WHERE workspace_id=$1 AND id=$2', [workspaceId, agentId]);
  return result.rowCount ? mapTrigger(result.rows[0]) : null;
}

export async function deleteAgentTrigger(workspaceId: string, agentId: string, triggerId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM agent_triggers WHERE workspace_id=$1 AND agent_id=$2 AND id=$3', [workspaceId, agentId, triggerId]);
  if (result.rowCount) await db.query('UPDATE agent_definitions SET version=version+1,updated_at=NOW() WHERE workspace_id=$1 AND id=$2', [workspaceId, agentId]);
  return Boolean(result.rowCount);
}

export function resetAgentRepositoryForTests(): void {}
