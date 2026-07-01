import { randomUUID } from 'node:crypto';
import { defaultWorkflowDefinitions } from './repository-workflow-defaults.js';
import { resetWorkflowRunRepositoryForTests } from './repository-workflow-runs.js';
import { listAgentDefinitions } from './repository-agents.js';
export type { WorkflowApprovalRecord, WorkflowMessageRecord, WorkflowRunRecord, WorkflowSessionRecord } from './repository-workflow-runs.js';
export { appendWorkflowRunEvents, createWorkflowRun, createWorkflowSession, createWorkflowUserMessage, decideWorkflowRunApproval, getWorkflowRun, getWorkflowRunApproval, getWorkflowSession, listWorkflowApprovalsForWorkspace, listWorkflowMessages, listWorkflowRunApprovals, listWorkflowRunsForSession, listWorkflowSessions, updateWorkflowRun, upsertWorkflowAssistantFinalMessage } from './repository-workflow-runs.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowCategory,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
  WorkflowOptionsCatalog,
  WorkflowStepDefinition
} from '../types/workflows.js';

const workflowDefinitionsByWorkspace = new Map<string, Map<string, WorkflowDefinitionForAccess>>();

export interface WorkflowMcpToolRecord {
  name: string;
  title: string;
  capability: 'read' | 'write';
  enabled: boolean;
}

export interface WorkflowMcpServerRecord {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  enabled: boolean;
  authType: 'none' | 'bearer_token' | 'custom_header';
  publicHeaders: Record<string, string>;
  status: 'connected' | 'disabled' | 'not_checked' | 'error';
  lastCheckedAt?: string;
  tools: WorkflowMcpToolRecord[];
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

export interface WorkflowMcpServerInput {
  name: string;
  url: string;
  enabled?: boolean;
  auth?: {
    type?: WorkflowMcpServerRecord['authType'];
  };
  publicHeaders?: Record<string, string>;
  createdBy: string;
}

const workflowMcpServersByWorkspace = new Map<string, Map<string, WorkflowMcpServerRecord>>();

export interface WorkflowDefinitionScopeUpdate {
  name?: string;
  description?: string;
  status?: WorkflowDefinitionForAccess['status'];
  category?: WorkflowCategory;
  tags?: string[];
  inputs?: WorkflowInputDefinition[];
  enabledMcpServers?: string[];
  enabledSkills?: string[];
  requiredPermissions?: WorkflowDefinitionForAccess['requiredPermissions'];
  policy?: {
    mode?: WorkflowDefinitionForAccess['policy']['mode'];
    maxRuntimeSeconds?: number;
    retentionDays?: number;
    approvalRequirements?: string[];
  };
  steps?: Array<{
    id: string;
    title?: string;
    requiredInputs?: string[];
    agentIds?: string[];
    targetBinding?: WorkflowStepDefinition['targetBinding'];
    enabledSkills?: string[];
    allowedMcpServers?: string[];
    allowedTools?: string[];
    contextGrants?: string[];
    approvalRequired?: boolean;
    outputArtifacts?: WorkflowStepDefinition['outputArtifacts'];
  }>;
  starterPrompt?: string;
}

export interface CreateWorkflowDefinitionInput {
  workspaceId: string;
  name: string;
  description?: string;
  category: WorkflowCategory;
  orchestratorAgentId?: string;
  tags?: string[];
  inputs?: WorkflowInputDefinition[];
  enabledMcpServers?: string[];
  enabledSkills?: string[];
  requiredPermissions: WorkflowDefinitionForAccess['requiredPermissions'];
  policy: WorkflowDefinitionForAccess['policy'];
  steps: WorkflowStepDefinition[];
  starterPrompt?: string;
  createdBy: string;
}

function cloneWorkflowDefinition(definition: WorkflowDefinitionForAccess): WorkflowDefinitionForAccess {
  return {
    ...definition,
    tags: [...(definition.tags || [])],
    inputs: (definition.inputs || []).map((input) => ({ ...input })),
    enabledMcpServers: [...(definition.enabledMcpServers || [])],
    enabledSkills: [...(definition.enabledSkills || [])],
    requiredPermissions: [...definition.requiredPermissions],
    policy: {
      ...definition.policy,
      approvalRequirements: [...definition.policy.approvalRequirements]
    },
    steps: definition.steps.map((step) => ({
      ...step,
      requiredInputs: [...step.requiredInputs],
      agentIds: step.agentIds ? [...step.agentIds] : undefined,
      targetBinding: step.targetBinding ? { ...step.targetBinding } : undefined,
      enabledSkills: [...step.enabledSkills],
      allowedMcpServers: [...step.allowedMcpServers],
      allowedTools: [...step.allowedTools],
      contextGrants: [...step.contextGrants],
      outputArtifacts: (step.outputArtifacts || []).map((artifact) => ({ ...artifact }))
    }))
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function definitionsForWorkspace(workspaceId: string): Map<string, WorkflowDefinitionForAccess> {
  const existing = workflowDefinitionsByWorkspace.get(workspaceId);
  if (existing) return existing;
  const definitions = new Map<string, WorkflowDefinitionForAccess>();
  for (const definition of defaultWorkflowDefinitions(workspaceId)) {
    definitions.set(definition.id, definition);
  }
  workflowDefinitionsByWorkspace.set(workspaceId, definitions);
  return definitions;
}

export function listWorkflowDefinitions(workspaceId: string): WorkflowDefinitionForAccess[] {
  return [...definitionsForWorkspace(workspaceId).values()].map(cloneWorkflowDefinition);
}

export function getWorkflowDefinition(workspaceId: string, workflowId: string): WorkflowDefinitionForAccess | null {
  const definition = definitionsForWorkspace(workspaceId).get(workflowId);
  return definition ? cloneWorkflowDefinition(definition) : null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function uniqueSortedCapabilities(values: WorkflowDefinitionForAccess['requiredPermissions']): WorkflowDefinitionForAccess['requiredPermissions'] {
  return uniqueSorted(values) as WorkflowDefinitionForAccess['requiredPermissions'];
}

function updateStepScope(step: WorkflowStepDefinition, update: NonNullable<WorkflowDefinitionScopeUpdate['steps']>[number]): WorkflowStepDefinition {
  return {
    ...step,
    title: update.title || step.title,
    requiredInputs: update.requiredInputs ? uniqueSorted(update.requiredInputs) : step.requiredInputs,
    agentIds: update.agentIds ? uniqueSorted(update.agentIds) : step.agentIds,
    targetBinding: update.targetBinding || step.targetBinding,
    enabledSkills: update.enabledSkills ? uniqueSorted(update.enabledSkills) : step.enabledSkills,
    allowedMcpServers: update.allowedMcpServers ? uniqueSorted(update.allowedMcpServers) : step.allowedMcpServers,
    allowedTools: update.allowedTools ? uniqueSorted(update.allowedTools) : step.allowedTools,
    contextGrants: update.contextGrants ? uniqueSorted(update.contextGrants) : step.contextGrants,
    approvalRequired: typeof update.approvalRequired === 'boolean' ? update.approvalRequired : step.approvalRequired,
    outputArtifacts: update.outputArtifacts ? update.outputArtifacts.map((artifact) => ({ ...artifact })) : step.outputArtifacts
  };
}

export function createWorkflowDefinition(input: CreateWorkflowDefinitionInput): WorkflowDefinitionForAccess {
  const now = nowIso();
  const id = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || `workflow-${randomUUID()}`;
  const definitions = definitionsForWorkspace(input.workspaceId);
  let candidateId = id;
  let suffix = 2;
  while (definitions.has(candidateId)) {
    candidateId = `${id}-${suffix}`;
    suffix += 1;
  }
  const definition: WorkflowDefinitionForAccess = {
    id: candidateId,
    workspaceId: input.workspaceId,
    version: 1,
    source: 'user',
    name: input.name.trim(),
    description: input.description?.trim(),
    status: 'draft',
    category: input.category,
    orchestratorAgentId: input.orchestratorAgentId || 'agent-workflow-orchestrator',
    tags: uniqueSorted(input.tags || []),
    inputs: (input.inputs || []).map((item) => ({ ...item })),
    enabledMcpServers: uniqueSorted(input.enabledMcpServers || input.steps.flatMap((step) => step.allowedMcpServers)),
    enabledSkills: uniqueSorted(input.enabledSkills || input.steps.flatMap((step) => step.enabledSkills)),
    requiredPermissions: uniqueSortedCapabilities(input.requiredPermissions),
    policy: {
      mode: input.policy.mode,
      maxRuntimeSeconds: input.policy.maxRuntimeSeconds,
      retentionDays: input.policy.retentionDays,
      approvalRequirements: uniqueSorted(input.policy.approvalRequirements)
    },
    steps: input.steps.map((step) => ({
      ...step,
      requiredInputs: uniqueSorted(step.requiredInputs),
      agentIds: step.agentIds ? uniqueSorted(step.agentIds) : undefined,
      enabledSkills: uniqueSorted(step.enabledSkills),
      allowedMcpServers: uniqueSorted(step.allowedMcpServers),
      allowedTools: uniqueSorted(step.allowedTools),
      contextGrants: uniqueSorted(step.contextGrants),
      outputArtifacts: (step.outputArtifacts || []).map((artifact) => ({ ...artifact }))
    })),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    starterPrompt: input.starterPrompt?.trim()
  };
  definitions.set(definition.id, definition);
  return cloneWorkflowDefinition(definition);
}

export function updateWorkflowDefinitionScope(
  workspaceId: string,
  workflowId: string,
  update: WorkflowDefinitionScopeUpdate
): WorkflowDefinitionForAccess | null {
  const definitions = definitionsForWorkspace(workspaceId);
  const current = definitions.get(workflowId);
  if (!current) {
    return null;
  }

  const stepUpdates = new Map((update.steps || []).map((step) => [step.id, step]));
  const updated: WorkflowDefinitionForAccess = {
    ...current,
    version: current.version + 1,
    name: update.name?.trim() || current.name,
    description: typeof update.description === 'string' ? update.description.trim() : current.description,
    status: update.status || current.status,
    category: update.category || current.category,
    tags: update.tags ? uniqueSorted(update.tags) : current.tags,
    inputs: update.inputs ? update.inputs.map((input) => ({ ...input })) : current.inputs,
    enabledMcpServers: update.enabledMcpServers ? uniqueSorted(update.enabledMcpServers) : current.enabledMcpServers,
    enabledSkills: update.enabledSkills ? uniqueSorted(update.enabledSkills) : current.enabledSkills,
    requiredPermissions: update.requiredPermissions
      ? uniqueSortedCapabilities(update.requiredPermissions)
      : current.requiredPermissions,
    policy: {
      ...current.policy,
      mode: update.policy?.mode || current.policy.mode,
      maxRuntimeSeconds: update.policy?.maxRuntimeSeconds || current.policy.maxRuntimeSeconds,
      retentionDays: update.policy?.retentionDays || current.policy.retentionDays,
      approvalRequirements: update.policy?.approvalRequirements
        ? uniqueSorted(update.policy.approvalRequirements)
        : current.policy.approvalRequirements
    },
    steps: current.steps.map((step) => {
      const stepUpdate = stepUpdates.get(step.id);
      return stepUpdate ? updateStepScope(step, stepUpdate) : step;
    }),
    starterPrompt: typeof update.starterPrompt === 'string' ? update.starterPrompt.trim() : current.starterPrompt,
    updatedAt: nowIso()
  };
  definitions.set(workflowId, updated);
  return cloneWorkflowDefinition(updated);
}

export function deleteWorkflowDefinition(workspaceId: string, workflowId: string): 'deleted' | 'system' | 'not_found' {
  const definitions = definitionsForWorkspace(workspaceId);
  const current = definitions.get(workflowId);
  if (!current) return 'not_found';
  if ((current.source || 'system') === 'system') return 'system';
  definitions.delete(workflowId);
  return 'deleted';
}

function cloneWorkflowMcpServer(server: WorkflowMcpServerRecord): WorkflowMcpServerRecord {
  return {
    ...server,
    publicHeaders: { ...server.publicHeaders },
    tools: server.tools.map((tool) => ({ ...tool }))
  };
}

function defaultWorkflowMcpServers(workspaceId: string): WorkflowMcpServerRecord[] {
  const createdAt = nowIso();
  return [
    {
      id: 'acornops-cluster-agent',
      workspaceId,
      name: 'AcornOps cluster agent',
      url: 'builtin://cluster-agent',
      enabled: true,
      authType: 'none',
      publicHeaders: {},
      status: 'connected',
      lastCheckedAt: createdAt,
      createdBy: 'system',
      createdAt,
      tools: [
        { name: 'inventory.resources.list', title: 'List cluster resources', capability: 'read', enabled: true },
        { name: 'events.search', title: 'Search cluster events', capability: 'read', enabled: true },
        { name: 'logs.summarize', title: 'Summarize logs', capability: 'read', enabled: true },
        { name: 'metrics.query', title: 'Query metrics', capability: 'read', enabled: true }
      ]
    },
    {
      id: 'github',
      workspaceId,
      name: 'GitHub',
      url: 'https://api.github.com/mcp',
      enabled: true,
      authType: 'bearer_token',
      publicHeaders: {},
      status: 'not_checked',
      createdBy: 'system',
      createdAt,
      tools: [
        { name: 'github.repositories.read', title: 'Read repositories', capability: 'read', enabled: true },
        { name: 'github.branches.list', title: 'List branches', capability: 'read', enabled: true },
        { name: 'github.prs.list', title: 'List pull requests', capability: 'read', enabled: true },
        { name: 'github.branches.create', title: 'Create branches', capability: 'write', enabled: true },
        { name: 'github.prs.create', title: 'Create pull requests', capability: 'write', enabled: true }
      ]
    },
    {
      id: 'workspace-chat',
      workspaceId,
      name: 'Workspace chat history',
      url: 'builtin://workspace-chat',
      enabled: true,
      authType: 'none',
      publicHeaders: {},
      status: 'connected',
      lastCheckedAt: createdAt,
      createdBy: 'system',
      createdAt,
      tools: [
        { name: 'chat.sessions.read_selected', title: 'Read selected chat sessions', capability: 'read', enabled: true }
      ]
    },
    {
      id: 'artifact-writer',
      workspaceId,
      name: 'Artifact writer',
      url: 'builtin://artifacts',
      enabled: true,
      authType: 'none',
      publicHeaders: {},
      status: 'connected',
      lastCheckedAt: createdAt,
      createdBy: 'system',
      createdAt,
      tools: [
        { name: 'reports.pdf.generate', title: 'Generate PDF report', capability: 'read', enabled: true }
      ]
    }
  ];
}

function mcpServersForWorkspace(workspaceId: string): Map<string, WorkflowMcpServerRecord> {
  const existing = workflowMcpServersByWorkspace.get(workspaceId);
  if (existing) return existing;
  const servers = new Map<string, WorkflowMcpServerRecord>();
  for (const server of defaultWorkflowMcpServers(workspaceId)) {
    servers.set(server.id, server);
  }
  workflowMcpServersByWorkspace.set(workspaceId, servers);
  return servers;
}

export function listWorkflowMcpServers(workspaceId: string): WorkflowMcpServerRecord[] {
  return [...mcpServersForWorkspace(workspaceId).values()].map(cloneWorkflowMcpServer);
}

export function createWorkflowMcpServer(workspaceId: string, input: WorkflowMcpServerInput): WorkflowMcpServerRecord {
  const servers = mcpServersForWorkspace(workspaceId);
  const idBase = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'mcp-server';
  let id = idBase;
  let suffix = 2;
  while (servers.has(id)) {
    id = `${idBase}-${suffix}`;
    suffix += 1;
  }
  const now = nowIso();
  const server: WorkflowMcpServerRecord = {
    id,
    workspaceId,
    name: input.name.trim(),
    url: input.url.trim(),
    enabled: input.enabled ?? true,
    authType: input.auth?.type || 'none',
    publicHeaders: input.publicHeaders || {},
    status: input.enabled === false ? 'disabled' : 'not_checked',
    tools: [],
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now
  };
  servers.set(id, server);
  return cloneWorkflowMcpServer(server);
}

export function updateWorkflowMcpServer(
  workspaceId: string,
  serverId: string,
  patch: Partial<Omit<WorkflowMcpServerInput, 'createdBy'>>
): WorkflowMcpServerRecord | null {
  const servers = mcpServersForWorkspace(workspaceId);
  const current = servers.get(serverId);
  if (!current) return null;
  const updated: WorkflowMcpServerRecord = {
    ...current,
    name: patch.name?.trim() || current.name,
    url: patch.url?.trim() || current.url,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    authType: patch.auth?.type || current.authType,
    publicHeaders: patch.publicHeaders || current.publicHeaders,
    status: typeof patch.enabled === 'boolean' && !patch.enabled ? 'disabled' : current.status,
    updatedAt: nowIso()
  };
  servers.set(serverId, updated);
  return cloneWorkflowMcpServer(updated);
}

export function deleteWorkflowMcpServer(workspaceId: string, serverId: string): boolean {
  return mcpServersForWorkspace(workspaceId).delete(serverId);
}

export function testWorkflowMcpServerConnection(workspaceId: string, serverId: string): WorkflowMcpServerRecord | null {
  const servers = mcpServersForWorkspace(workspaceId);
  const current = servers.get(serverId);
  if (!current) return null;
  const updated: WorkflowMcpServerRecord = {
    ...current,
    status: current.enabled ? 'connected' : 'disabled',
    lastCheckedAt: nowIso(),
    updatedAt: nowIso()
  };
  servers.set(serverId, updated);
  return cloneWorkflowMcpServer(updated);
}

export function listWorkflowMcpServerTools(workspaceId: string, serverId: string): WorkflowMcpToolRecord[] | null {
  const server = mcpServersForWorkspace(workspaceId).get(serverId);
  return server ? server.tools.map((tool) => ({ ...tool })) : null;
}

export function getWorkflowOptionsCatalog(workspaceId: string): WorkflowOptionsCatalog {
  const servers = listWorkflowMcpServers(workspaceId);
  const tools = servers.flatMap((server) => server.tools.map((tool) => ({
    value: tool.name,
    label: tool.title,
    description: `${server.name} - ${tool.capability}`,
    disabled: !server.enabled || !tool.enabled,
    disabledReason: !server.enabled ? 'MCP server disabled' : !tool.enabled ? 'Tool disabled' : undefined
  })));
  return {
    clusters: [
      { value: 'cluster-primary', label: 'Primary cluster', description: 'Default Kubernetes cluster' },
      { value: 'cluster-staging', label: 'Staging cluster', description: 'Staging Kubernetes cluster' }
    ],
    repositories: [
      { value: 'acornops/control-plane', label: 'acornops/control-plane' },
      { value: 'acornops/management-console', label: 'acornops/management-console' }
    ],
    mcpServers: servers.map((server) => ({
      value: server.id,
      label: server.name,
      description: server.url,
      disabled: !server.enabled,
      disabledReason: !server.enabled ? 'Server disabled' : undefined
    })),
    mcpTools: tools,
    skills: [
      { value: 'acornops-observability', label: 'AcornOps observability', description: 'Incident and signal analysis' },
      { value: 'acornops-cross-repo-change', label: 'Cross-repo change', description: 'Multi-repository coordination' },
      { value: 'acornops-open-pr', label: 'Open PR', description: 'Prepare branch and pull request handoff' },
      { value: 'acornops-target-boundary-design', label: 'Target boundary design', description: 'Target model compatibility checks' }
    ],
    agents: listAgentDefinitions(workspaceId).filter((agent) => agent.kind === 'specialist_agent').map((agent) => ({
      value: agent.id,
      label: agent.name,
      description: agent.description,
      disabled: agent.status !== 'active',
      disabledReason: agent.status !== 'active' ? 'Agent disabled' : undefined
    })),
    chatSessions: [
      { value: 'chat-incident-001', label: 'Incident chat 001', description: 'Selected cluster incident thread' },
      { value: 'chat-incident-002', label: 'Incident chat 002', description: 'Follow-up mitigation thread' }
    ],
    outputFormats: [
      { value: 'pdf', label: 'PDF' },
      { value: 'markdown', label: 'Markdown' }
    ],
    approvalPolicies: [
      { value: 'none', label: 'No approval' },
      { value: 'before_write', label: 'Before write-capable tools' },
      { value: 'before_chat_read', label: 'Before reading selected chats' }
    ],
    runtimeLimits: [
      { value: '600', label: '10 minutes' },
      { value: '900', label: '15 minutes' },
      { value: '1500', label: '25 minutes' }
    ],
    retentionPolicies: [
      { value: '30', label: '30 days' },
      { value: '90', label: '90 days' },
      { value: '180', label: '180 days' }
    ]
  };
}

export function resetWorkflowRepositoryForTests(): void {
  resetWorkflowRunRepositoryForTests();
  workflowDefinitionsByWorkspace.clear();
  workflowMcpServersByWorkspace.clear();
}
