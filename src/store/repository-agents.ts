import { randomUUID } from 'node:crypto';
import type {
  AgentActivityRecord,
  AgentDefinition,
  AgentTriggerDefinition,
  AgentTriggerType,
  AgentVersionSnapshot,
  CompiledAgentRunScope
} from '../types/agents.js';

const agentsByWorkspace = new Map<string, Map<string, AgentDefinition>>();
const versionsByAgent = new Map<string, AgentVersionSnapshot[]>();
const activityByAgent = new Map<string, AgentActivityRecord[]>();

export interface CreateAgentDefinitionInput {
  workspaceId: string;
  name: string;
  description?: string;
  instructions: string;
  ownerUserId: string;
  createdBy: string;
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
    activity: { ...agent.activity }
  };
}

function cloneVersion(version: AgentVersionSnapshot): AgentVersionSnapshot {
  return {
    ...version,
    snapshot: cloneAgent(version.snapshot)
  };
}

function cloneActivity(record: AgentActivityRecord): AgentActivityRecord {
  return {
    ...record,
    triggeredBy: { ...record.triggeredBy },
    inputContext: { ...record.inputContext },
    compiledScope: {
      ...record.compiledScope,
      actor: { ...record.compiledScope.actor },
      mcpServers: [...record.compiledScope.mcpServers],
      tools: [...record.compiledScope.tools],
      toolOperations: { ...record.compiledScope.toolOperations },
      enabledSkills: [...record.compiledScope.enabledSkills],
      contextGrants: [...record.compiledScope.contextGrants],
      approvalGates: [...record.compiledScope.approvalGates],
      targetScope: {
        type: record.compiledScope.targetScope.type,
        ...(record.compiledScope.targetScope.targetTypes ? { targetTypes: [...record.compiledScope.targetScope.targetTypes] } : {}),
        ...(record.compiledScope.targetScope.targetIds ? { targetIds: [...record.compiledScope.targetScope.targetIds] } : {})
      },
      jwtClaims: {
        ...record.compiledScope.jwtClaims,
        permissions: {
          allowed_tools: [...record.compiledScope.jwtClaims.permissions.allowed_tools],
          allowed_tool_operations: { ...record.compiledScope.jwtClaims.permissions.allowed_tool_operations },
          context_grants: [...record.compiledScope.jwtClaims.permissions.context_grants]
        }
      }
    },
    toolCalls: record.toolCalls.map((toolCall) => ({ ...toolCall })),
    outputArtifacts: record.outputArtifacts.map((artifact) => ({ ...artifact }))
  };
}

function defaultAgents(workspaceId: string): AgentDefinition[] {
  const now = nowIso();
  return [
    {
      id: 'agent-cluster-triage',
      workspaceId,
      name: 'Cluster triage agent',
      description: 'Collects Kubernetes signals and summarizes likely incident causes.',
      instructions: 'Use read-only cluster inventory, event, log, and metric tools.',
      status: 'active',
      source: 'system',
      providerType: 'internal',
      version: 1,
      ownerUserId: 'system',
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      mcpServers: ['acornops-cluster-agent'],
      tools: ['events.search', 'inventory.resources.list', 'logs.summarize', 'metrics.query'],
      skills: ['acornops-observability'],
      contextGrants: ['target_inventory', 'workspace_metadata'],
      targetScope: { type: 'workspace', targetTypes: ['kubernetes'] },
      approvalPolicy: { mode: 'none', writeToolsRequireApproval: true },
      trustPolicy: { level: 'restricted', allowExternalData: false },
      triggers: [],
      activity: { runCount: 0 }
    },
    {
      id: 'agent-release-coordinator',
      workspaceId,
      name: 'Release coordinator agent',
      description: 'Reads repository context and prepares release handoff notes.',
      instructions: 'Coordinate release checks; request approval before write tools.',
      status: 'active',
      source: 'system',
      providerType: 'internal',
      version: 1,
      ownerUserId: 'system',
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      mcpServers: ['github'],
      tools: ['github.repositories.read', 'github.branches.list', 'github.prs.list', 'github.branches.create', 'github.prs.create'],
      skills: ['acornops-cross-repo-change', 'acornops-open-pr'],
      contextGrants: ['workspace_metadata'],
      targetScope: { type: 'workspace' },
      approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
      trustPolicy: { level: 'restricted', allowExternalData: false },
      triggers: [],
      activity: { runCount: 0 }
    },
    {
      id: 'agent-incident-reporter',
      workspaceId,
      name: 'Incident reporter agent',
      description: 'Reads selected incident chats and produces report artifacts.',
      instructions: 'Use selected chat context only after approval and write the requested report artifact.',
      status: 'active',
      source: 'system',
      providerType: 'internal',
      version: 1,
      ownerUserId: 'system',
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      mcpServers: ['workspace-chat', 'artifact-writer'],
      tools: ['chat.sessions.read_selected', 'reports.pdf.generate'],
      skills: ['acornops-observability'],
      contextGrants: ['selected_chat_sessions'],
      targetScope: { type: 'workspace' },
      approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
      trustPolicy: { level: 'restricted', allowExternalData: false },
      triggers: [],
      activity: { runCount: 0 }
    }
  ];
}

function workspaceAgents(workspaceId: string): Map<string, AgentDefinition> {
  const existing = agentsByWorkspace.get(workspaceId);
  if (existing) return existing;
  const agents = new Map<string, AgentDefinition>();
  for (const agent of defaultAgents(workspaceId)) {
    agents.set(agent.id, agent);
  }
  agentsByWorkspace.set(workspaceId, agents);
  return agents;
}

export function listAgentDefinitions(workspaceId: string, options: { includeInactive?: boolean } = {}): AgentDefinition[] {
  return [...workspaceAgents(workspaceId).values()]
    .filter((agent) => options.includeInactive || agent.status === 'active')
    .map(cloneAgent);
}

export function getAgentDefinition(workspaceId: string, agentId: string): AgentDefinition | null {
  const agent = workspaceAgents(workspaceId).get(agentId);
  return agent ? cloneAgent(agent) : null;
}

export function createAgentDefinition(input: CreateAgentDefinitionInput): AgentDefinition {
  const agents = workspaceAgents(input.workspaceId);
  const idBase = `agent-${slug(input.name, 'custom')}`;
  let id = idBase;
  let suffix = 2;
  while (agents.has(id)) {
    id = `${idBase}-${suffix}`;
    suffix += 1;
  }
  const now = nowIso();
  const agent: AgentDefinition = {
    id,
    workspaceId: input.workspaceId,
    name: input.name.trim(),
    description: input.description?.trim(),
    instructions: input.instructions.trim(),
    status: 'active',
    source: 'user',
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
    activity: { runCount: 0 }
  };
  agents.set(agent.id, agent);
  return cloneAgent(agent);
}

export function updateAgentDefinition(workspaceId: string, agentId: string, patch: AgentDefinitionUpdate): AgentDefinition | null {
  const agents = workspaceAgents(workspaceId);
  const current = agents.get(agentId);
  if (!current) return null;
  const updated: AgentDefinition = {
    ...current,
    name: patch.name?.trim() || current.name,
    description: typeof patch.description === 'string' ? patch.description.trim() : current.description,
    instructions: patch.instructions?.trim() || current.instructions,
    status: patch.status || current.status,
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
  agents.set(agentId, updated);
  return cloneAgent(updated);
}

export function createAgentVersionSnapshot(workspaceId: string, agentId: string, createdBy: string): AgentVersionSnapshot | null {
  const agent = workspaceAgents(workspaceId).get(agentId);
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
  const versions = versionsByAgent.get(agentId) || [];
  versions.push(version);
  versionsByAgent.set(agentId, versions);
  return cloneVersion(version);
}

export function listAgentVersionSnapshots(workspaceId: string, agentId: string): AgentVersionSnapshot[] {
  return (versionsByAgent.get(agentId) || [])
    .filter((version) => version.workspaceId === workspaceId)
    .map(cloneVersion);
}

export function createAgentTrigger(workspaceId: string, agentId: string, input: CreateAgentTriggerInput): AgentTriggerDefinition | null {
  const agents = workspaceAgents(workspaceId);
  const agent = agents.get(agentId);
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
  const updated = {
    ...agent,
    version: agent.version + 1,
    triggers: [...agent.triggers, trigger],
    updatedAt: now
  };
  agents.set(agentId, updated);
  return { ...trigger, schedule: trigger.schedule ? { ...trigger.schedule } : undefined };
}

export function updateAgentTrigger(
  workspaceId: string,
  agentId: string,
  triggerId: string,
  patch: Partial<CreateAgentTriggerInput>
): AgentTriggerDefinition | null {
  const agents = workspaceAgents(workspaceId);
  const agent = agents.get(agentId);
  if (!agent) return null;
  const trigger = agent.triggers.find((candidate) => candidate.id === triggerId);
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
  agents.set(agentId, {
    ...agent,
    version: agent.version + 1,
    triggers: agent.triggers.map((candidate) => candidate.id === triggerId ? updatedTrigger : candidate),
    updatedAt: updatedTrigger.updatedAt || nowIso()
  });
  return { ...updatedTrigger, schedule: updatedTrigger.schedule ? { ...updatedTrigger.schedule } : undefined };
}

export function deleteAgentTrigger(workspaceId: string, agentId: string, triggerId: string): boolean {
  const agents = workspaceAgents(workspaceId);
  const agent = agents.get(agentId);
  if (!agent) return false;
  const triggers = agent.triggers.filter((trigger) => trigger.id !== triggerId);
  if (triggers.length === agent.triggers.length) return false;
  agents.set(agentId, {
    ...agent,
    version: agent.version + 1,
    triggers,
    updatedAt: nowIso()
  });
  return true;
}

export function createAgentActivityRecord(input: {
  agent: AgentDefinition;
  triggerId?: string;
  status: AgentActivityRecord['status'];
  triggeredBy: AgentActivityRecord['triggeredBy'];
  inputContext: Record<string, unknown>;
  compiledScope: CompiledAgentRunScope;
}): AgentActivityRecord {
  const now = nowIso();
  const record: AgentActivityRecord = {
    id: randomUUID(),
    agentId: input.agent.id,
    workspaceId: input.agent.workspaceId,
    agentVersion: input.agent.version,
    triggerId: input.triggerId,
    status: input.status,
    triggeredBy: { ...input.triggeredBy },
    inputContext: { ...input.inputContext },
    compiledScope: input.compiledScope,
    toolCalls: [],
    outputArtifacts: [],
    createdAt: now,
    updatedAt: now
  };
  const records = activityByAgent.get(input.agent.id) || [];
  records.unshift(record);
  activityByAgent.set(input.agent.id, records);

  const agents = workspaceAgents(input.agent.workspaceId);
  const current = agents.get(input.agent.id);
  if (current) {
    agents.set(input.agent.id, {
      ...current,
      activity: {
        runCount: current.activity.runCount + 1,
        lastRunAt: now,
        lastStatus: input.status
      }
    });
  }
  return cloneActivity(record);
}

export function listAgentActivityRecords(workspaceId: string, agentId: string): AgentActivityRecord[] {
  return (activityByAgent.get(agentId) || [])
    .filter((record) => record.workspaceId === workspaceId)
    .map(cloneActivity);
}

export function resetAgentRepositoryForTests(): void {
  agentsByWorkspace.clear();
  versionsByAgent.clear();
  activityByAgent.clear();
}
