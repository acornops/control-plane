import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { AgentDefinition, AgentTriggerDefinition, AgentVersionSnapshot } from '../types/agents.js';
import type {
  AgentDefinitionUpdate,
  CreateAgentDefinitionInput,
  CreateAgentTriggerInput
} from './repository-agent-types.js';
import { computeNextWorkflowScheduleRunAt } from './repository-workflow-schedules.js';

export type {
  AgentDefinitionUpdate,
  CreateAgentDefinitionInput,
  CreateAgentTriggerInput
} from './repository-agent-types.js';

export {
  appendAgentRunEvents,
  createAgentRunActivity,
  getAgentActivityRecord,
  listAgentActivityRecords,
  listAgentRunEvents,
  updateAgentActivityRecord
} from './repository-agent-activity.js';

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
  const mcpServers = agent.mcpServers || [];
  const mcpTools = agent.mcpTools || [];
  const mcpInstallations = agent.mcpInstallations || [];
  const skillInstallations = agent.skillInstallations || [];
  return {
    ...agent,
    origin: { ...agent.origin },
    mcpServers: [...mcpServers],
    mcpTools: mcpTools.map((tool) => ({ ...tool })),
    mcpInstallations: mcpInstallations.map((installation) => ({
      ...installation,
      targetConstraints: {
        targetTypes: [...(installation.targetConstraints?.targetTypes || [])],
        targetIds: [...(installation.targetConstraints?.targetIds || [])]
      },
      provenance: installation.provenance ? { ...installation.provenance } : undefined,
      tools: installation.tools.map((tool) => ({ ...tool }))
    })),
    tools: [...agent.tools],
    skills: [...agent.skills],
    skillInstallations: skillInstallations.map((installation) => ({
      ...installation,
      source: { ...installation.source },
      files: installation.files.map((file) => ({ ...file }))
    })),
    contextGrants: [...(agent.contextGrants || [])],
    targetScope: {
      type: agent.targetScope.type,
      ...(agent.targetScope.targetTypes ? { targetTypes: [...agent.targetScope.targetTypes] } : {}),
      ...(agent.targetScope.targetIds ? { targetIds: [...agent.targetScope.targetIds] } : {})
    },
    approvalPolicy: { ...agent.approvalPolicy },
    trustPolicy: { ...agent.trustPolicy },
    permissionMode: agent.permissionMode || 'ask_before_changes',
    semanticCapabilityIds: [...(agent.semanticCapabilityIds || [])],
    delegateAgentIds: [...(agent.delegateAgentIds || [])],
    triggers: (agent.triggers || []).map((trigger) => ({
      ...trigger,
      schedule: trigger.schedule ? { ...trigger.schedule } : undefined,
      eventFilter: trigger.eventFilter ? { ...trigger.eventFilter } : undefined
    })),
    activity: { ...agent.activity },
    readiness: agent.readiness
      ? { status: agent.readiness.status, reasons: [...agent.readiness.reasons] }
      : { status: 'needs_setup', reasons: ['Agent version predates capability readiness snapshots.'] }
  };
}

type AgentRow = QueryResultRow;
type Queryable = Pick<PoolClient, 'query'>;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapTrigger(row: AgentRow): AgentTriggerDefinition {
  return { id: row.id, type: row.type, enabled: row.enabled, name: row.name || undefined,
    schedule: row.schedule || undefined, eventFilter: row.event_filter || undefined,
    principal: row.principal || undefined,
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at) };
}

async function triggersFor(
  workspaceId: string,
  agentId: string,
  queryable: Queryable = db
): Promise<AgentTriggerDefinition[]> {
  const result = await queryable.query<AgentRow>(
    'SELECT * FROM agent_triggers WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at,id', [workspaceId, agentId]
  );
  return result.rows.map(mapTrigger);
}

async function mapAgent(row: AgentRow, queryable: Queryable = db): Promise<AgentDefinition> {
  const agent: AgentDefinition = {
    id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description || undefined,
    instructions: row.instructions, status: row.status, kind: row.kind,
    systemRole: row.system_role || undefined,
    origin: row.origin || { type: 'manual' }, reviewState: row.review_state || 'reviewed',
    providerType: row.provider_type, version: row.version, ownerUserId: row.owner_user_id,
    createdBy: row.created_by, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    mcpServers: row.mcp_servers || [], mcpTools: row.mcp_tools || [],
    mcpInstallations: row.mcp_installations || [], tools: row.tools || [], skills: row.skills || [],
    skillInstallations: row.skill_installations || [],
    contextGrants: row.context_grants || [], targetScope: row.target_scope,
    approvalPolicy: row.approval_policy, trustPolicy: row.trust_policy,
    permissionMode: row.permission_mode || 'ask_before_changes',
    semanticCapabilityIds: row.semantic_capability_ids || [],
    delegateAgentIds: row.delegate_agent_ids || [],
    triggers: await triggersFor(row.workspace_id, row.id, queryable),
    activity: { runCount: row.run_count || 0, lastRunAt: iso(row.last_run_at), lastStatus: row.last_status || undefined },
    readiness: { status: row.readiness_status || 'needs_setup', reasons: row.readiness_reasons || [] }
  };
  return agent;
}

export async function listAgentDefinitions(workspaceId: string, options: { includeInactive?: boolean } = {}): Promise<AgentDefinition[]> {
  const result = await db.query<AgentRow>(
    `SELECT * FROM agent_definitions WHERE workspace_id=$1 ${options.includeInactive ? '' : "AND status='active'"} ORDER BY updated_at DESC,id`,
    [workspaceId]
  );
  return Promise.all(result.rows.map((row) => mapAgent(row)));
}

export async function getAgentDefinition(
  workspaceId: string,
  agentId: string,
  queryable: Queryable = db
): Promise<AgentDefinition | null> {
  const result = await queryable.query<AgentRow>(
    'SELECT * FROM agent_definitions WHERE workspace_id=$1 AND id=$2',
    [workspaceId, agentId]
  );
  return result.rowCount ? mapAgent(result.rows[0], queryable) : null;
}

export async function deleteAgentDefinition(workspaceId: string, agentId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM agent_definitions WHERE workspace_id=$1 AND id=$2', [workspaceId, agentId]);
  return Boolean(result.rowCount);
}

export async function createAgentDefinition(
  input: CreateAgentDefinitionInput,
  queryable: Queryable = db
): Promise<AgentDefinition> {
  const id = `agent-${slug(input.name, 'custom')}-${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  const agent: AgentDefinition = {
    id,
    workspaceId: input.workspaceId,
    name: input.name.trim(),
    description: input.description?.trim(),
    instructions: input.instructions.trim(),
    status: 'active',
    origin: input.origin || { type: 'manual' },
    kind: input.kind || 'specialist',
    systemRole: input.systemRole,
    reviewState: input.reviewState || 'reviewed',
    providerType: input.providerType || 'internal',
    version: 1,
    ownerUserId: input.ownerUserId,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    mcpServers: uniqueSorted(input.mcpServers),
    mcpTools: input.mcpTools || [],
    mcpInstallations: input.mcpInstallations || [],
    tools: uniqueSorted(input.tools),
    skills: uniqueSorted(input.skills),
    skillInstallations: input.skillInstallations || [],
    contextGrants: uniqueSorted(input.contextGrants),
    targetScope: input.targetScope || { type: 'workspace' },
    approvalPolicy: input.approvalPolicy || { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: input.trustPolicy || { level: 'restricted', allowExternalData: false },
    permissionMode: input.permissionMode || 'ask_before_changes',
    semanticCapabilityIds: uniqueSorted(input.semanticCapabilityIds),
    delegateAgentIds: uniqueSorted(input.delegateAgentIds),
    triggers: [],
    activity: { runCount: 0 },
    readiness: { status: 'needs_setup', reasons: ['Readiness has not been evaluated against the live capability catalog.'] }
  };
  const result = await queryable.query<AgentRow>(
    `INSERT INTO agent_definitions (
      workspace_id,id,name,description,instructions,status,origin,kind,review_state,provider_type,version,owner_user_id,created_by,
      mcp_servers,mcp_tools,mcp_installations,tools,skills,skill_installations,context_grants,target_scope,approval_policy,trust_policy,
      permission_mode,semantic_capability_ids,delegate_agent_ids,readiness_status,readiness_reasons,system_role
     ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'needs_setup',$25,$26) RETURNING *`,
    [input.workspaceId, id, agent.name, agent.description || null, agent.instructions, agent.origin, agent.kind, agent.reviewState, agent.providerType,
     agent.ownerUserId, agent.createdBy, JSON.stringify(agent.mcpServers), JSON.stringify(agent.mcpTools), JSON.stringify(agent.mcpInstallations),
     JSON.stringify(agent.tools), JSON.stringify(agent.skills), JSON.stringify(agent.skillInstallations), JSON.stringify(agent.contextGrants),
     agent.targetScope, agent.approvalPolicy, agent.trustPolicy, agent.permissionMode, JSON.stringify(agent.semanticCapabilityIds),
     JSON.stringify(agent.delegateAgentIds), JSON.stringify(agent.readiness.reasons), input.systemRole || null]
  );
  return mapAgent(result.rows[0], queryable);
}

export async function duplicateAgentDefinition(
  workspaceId: string,
  agentId: string,
  createdBy: string,
  requestedName?: string
): Promise<AgentDefinition | null> {
  const source = await getAgentDefinition(workspaceId, agentId);
  if (!source) return null;
  const name = requestedName?.trim() || `${source.name} copy`;
  const id = `agent-${slug(name, 'custom')}-${randomUUID().slice(0, 8)}`;
  const installedSkillIds = new Set(source.skillInstallations.map((skill) => skill.id));
  const inheritedSkills = source.skills.filter((skill) => !installedSkillIds.has(skill));
  const result = await db.query<AgentRow>(
    `INSERT INTO agent_definitions (
       workspace_id,id,name,description,instructions,status,origin,kind,review_state,provider_type,version,
       owner_user_id,created_by,mcp_servers,mcp_tools,mcp_installations,tools,skills,skill_installations,context_grants,target_scope,
       approval_policy,trust_policy,permission_mode,semantic_capability_ids,delegate_agent_ids,readiness_status,readiness_reasons
     ) VALUES (
       $1,$2,$3,$4,$5,'draft',$6,$7,'draft',$8,1,$9,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       'needs_setup',$23
     ) RETURNING *`,
    [
      workspaceId,
      id,
      name,
      source.description || null,
      source.instructions,
      { type: 'manual' },
      source.kind,
      source.providerType,
      createdBy,
      '[]',
      '[]',
      '[]',
      JSON.stringify(uniqueSorted(source.tools)),
      JSON.stringify(uniqueSorted(inheritedSkills)),
      '[]',
      JSON.stringify(uniqueSorted(source.contextGrants)),
      source.targetScope,
      source.approvalPolicy,
      source.trustPolicy,
      source.permissionMode,
      JSON.stringify(source.semanticCapabilityIds),
      JSON.stringify(source.delegateAgentIds),
      JSON.stringify(['Readiness has not been evaluated against the live capability catalog.'])
    ]
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
    reviewState: patch.reviewState || current.reviewState,
    providerType: patch.providerType || current.providerType,
    ownerUserId: patch.ownerUserId || current.ownerUserId,
    mcpServers: patch.mcpServers ? uniqueSorted(patch.mcpServers) : current.mcpServers,
    mcpTools: patch.mcpTools || current.mcpTools,
    mcpInstallations: patch.mcpInstallations || current.mcpInstallations,
    tools: patch.tools ? uniqueSorted(patch.tools) : current.tools,
    skills: patch.skills ? uniqueSorted(patch.skills) : current.skills,
    skillInstallations: patch.skillInstallations || current.skillInstallations,
    contextGrants: patch.contextGrants ? uniqueSorted(patch.contextGrants) : current.contextGrants,
    targetScope: patch.targetScope || current.targetScope,
    approvalPolicy: patch.approvalPolicy || current.approvalPolicy,
    trustPolicy: patch.trustPolicy || current.trustPolicy,
    permissionMode: patch.permissionMode || current.permissionMode,
    semanticCapabilityIds: patch.semanticCapabilityIds ? uniqueSorted(patch.semanticCapabilityIds) : current.semanticCapabilityIds,
    delegateAgentIds: patch.delegateAgentIds ? uniqueSorted(patch.delegateAgentIds) : current.delegateAgentIds,
    version: current.version + 1,
    updatedAt: nowIso()
  };
  const result = await db.query<AgentRow>(
    `UPDATE agent_definitions SET name=$3,description=$4,instructions=$5,status=$6,kind=$7,review_state=$8,provider_type=$9,
      owner_user_id=$10,mcp_servers=$11,mcp_tools=$12,mcp_installations=$13,tools=$14,skills=$15,skill_installations=$16,context_grants=$17,target_scope=$18,
      approval_policy=$19,trust_policy=$20,permission_mode=$21,semantic_capability_ids=$22,delegate_agent_ids=$23,version=version+1,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, agentId, updated.name, updated.description || null, updated.instructions, updated.status, updated.kind,
     updated.reviewState, updated.providerType, updated.ownerUserId, JSON.stringify(updated.mcpServers), JSON.stringify(updated.mcpTools),
     JSON.stringify(updated.mcpInstallations), JSON.stringify(updated.tools), JSON.stringify(updated.skills), JSON.stringify(updated.skillInstallations),
     JSON.stringify(updated.contextGrants), updated.targetScope, updated.approvalPolicy, updated.trustPolicy,
     updated.permissionMode, JSON.stringify(updated.semanticCapabilityIds), JSON.stringify(updated.delegateAgentIds)]
  );
  return result.rowCount ? mapAgent(result.rows[0]) : null;
}

export async function updateAgentSkillCapabilitySnapshot(
  workspaceId: string,
  agentId: string,
  skills: string[],
  skillInstallations: AgentDefinition['skillInstallations']
): Promise<AgentDefinition | null> {
  const result = await db.query(
    `UPDATE agent_definitions
     SET skills=$3,skill_installations=$4,version=version+1,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 AND kind='specialist'
     RETURNING id`,
    [workspaceId, agentId, JSON.stringify(uniqueSorted(skills)), JSON.stringify(skillInstallations)]
  );
  return result.rowCount ? getAgentDefinition(workspaceId, agentId) : null;
}

export async function updateAgentMcpCapabilitySnapshot(
  workspaceId: string,
  agentId: string,
  snapshot: Pick<AgentDefinition, 'mcpServers' | 'mcpTools' | 'mcpInstallations'>,
  updatedBy: string
): Promise<AgentDefinition | null> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('acornops.actor_user_id', $1, true)`, [updatedBy]);
    const result = await client.query(
      `UPDATE agent_definitions
       SET mcp_servers=$3,mcp_tools=$4,mcp_installations=$5,version=version+1,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND kind='specialist'
       RETURNING id`,
      [workspaceId, agentId, JSON.stringify(snapshot.mcpServers), JSON.stringify(snapshot.mcpTools), JSON.stringify(snapshot.mcpInstallations)]
    );
    await client.query('COMMIT');
    if (!result.rowCount) return null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAgentDefinition(workspaceId, agentId);
}

export async function updateAgentReadiness(
  workspaceId: string,
  agentId: string,
  readiness: AgentDefinition['readiness']
): Promise<AgentDefinition | null> {
  const result = await db.query(
    `UPDATE agent_definitions
     SET readiness_status=$3,readiness_reasons=$4,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [workspaceId, agentId, readiness.status, JSON.stringify(readiness.reasons)]
  );
  return result.rowCount ? getAgentDefinition(workspaceId, agentId) : null;
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
    principal: input.principal ? { ...input.principal } : undefined,
    createdAt: now,
    updatedAt: now
  };
  const nextOccurrenceAt = trigger.type === 'schedule' && trigger.schedule
    ? computeNextWorkflowScheduleRunAt(trigger.schedule.cron, new Date(), trigger.schedule.timezone)
    : null;
  const result = await db.query<AgentRow>(
    `INSERT INTO agent_triggers (workspace_id,agent_id,id,type,enabled,name,schedule,event_filter,principal,secret_ciphertext,next_occurrence_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [workspaceId, agentId, trigger.id, trigger.type, trigger.enabled, trigger.name || null,
     trigger.schedule || null, trigger.eventFilter || null, trigger.principal || null, input.secretCiphertext || null, nextOccurrenceAt, now]
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
    principal: patch.principal ? { ...patch.principal } : trigger.principal,
    updatedAt: nowIso()
  };
  const nextOccurrenceAt = updatedTrigger.type === 'schedule' && updatedTrigger.enabled && updatedTrigger.schedule
    ? computeNextWorkflowScheduleRunAt(updatedTrigger.schedule.cron, new Date(), updatedTrigger.schedule.timezone)
    : null;
  const result = await db.query<AgentRow>(
    `UPDATE agent_triggers SET type=$4,enabled=$5,name=$6,schedule=$7,event_filter=$8,principal=$9,next_occurrence_at=$10,updated_at=NOW()
     WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 RETURNING *`,
    [workspaceId, agentId, triggerId, updatedTrigger.type, updatedTrigger.enabled, updatedTrigger.name || null,
     updatedTrigger.schedule || null, updatedTrigger.eventFilter || null, updatedTrigger.principal || null, nextOccurrenceAt]
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
