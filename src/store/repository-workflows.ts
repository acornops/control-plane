import { randomUUID } from 'node:crypto';
import type {
  CompiledWorkflowAccessScope,
  WorkflowCategory,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
  WorkflowOptionsCatalog,
  WorkflowStepDefinition
} from '../types/workflows.js';
import type { RunEvent, RunStatus, ToolApprovalStatus } from '../types/domain.js';

export interface WorkflowSessionRecord {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowVersion: number;
  createdBy: string;
  compiledAccessScope: CompiledWorkflowAccessScope;
  createdAt: string;
}

export interface WorkflowMessageRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  workflowId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  inputs: Record<string, unknown>;
  runId?: string;
  createdAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflowRunId: string;
  workspaceId: string;
  workflowId: string;
  workflowSessionId: string;
  workflowStepId?: string;
  messageId: string;
  createdBy: string;
  status: RunStatus;
  compiledAccessScope: CompiledWorkflowAccessScope;
  llmProvider?: 'openai' | 'anthropic' | 'gemini';
  llmModel?: string;
  llmReasoningSummaryMode?: 'off' | 'auto' | 'concise' | 'detailed';
  llmReasoningEffort?: 'default' | 'low' | 'medium' | 'high';
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  assistantMessage?: {
    content: string;
    format?: string;
  };
  usage?: unknown;
  events?: RunEvent[];
  createdAt: string;
  updatedAt?: string;
}

export interface WorkflowApprovalRecord {
  id: string;
  runId: string;
  workspaceId: string;
  workflowId: string;
  workflowRunId: string;
  workflowSessionId: string;
  workflowStepId?: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
  status: ToolApprovalStatus;
  executionStatus: 'not_started' | 'executing' | 'succeeded' | 'failed' | 'unknown';
  requestedBy?: string;
  decidedBy?: string;
  decision?: 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

const workflowSessions = new Map<string, WorkflowSessionRecord>();
const workflowMessages = new Map<string, WorkflowMessageRecord>();
const workflowRuns = new Map<string, WorkflowRunRecord>();
const workflowApprovals = new Map<string, WorkflowApprovalRecord>();
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

function defaultWorkflowDefinitions(workspaceId: string): WorkflowDefinitionForAccess[] {
  return [
    {
      id: 'cluster-triage',
      workspaceId,
      version: 1,
      source: 'system',
      templateId: 'cluster-triage',
      name: 'Cluster triage',
      description: 'Inspect a selected cluster and summarize likely causes, severity, and next actions.',
      status: 'active',
      category: 'cluster-triage',
      tags: ['cluster', 'triage', 'incident'],
      enabledMcpServers: ['acornops-cluster-agent'],
      enabledSkills: ['acornops-observability', 'acornops-target-boundary-design'],
      inputs: [],
      requiredPermissions: ['read_workspace_data', 'create_read_only_runs'],
      policy: {
        mode: 'read_only',
        maxRuntimeSeconds: 900,
        retentionDays: 90,
        approvalRequirements: []
      },
      steps: [
        {
          id: 'collect-cluster-signals',
          title: 'Collect cluster signals',
          requiredInputs: [],
          targetBinding: { type: 'selected_cluster', targetType: 'kubernetes', inputName: 'clusterId' },
          enabledSkills: ['acornops-observability', 'acornops-target-boundary-design'],
          allowedMcpServers: ['acornops-cluster-agent'],
          allowedTools: ['inventory.resources.list', 'events.search', 'logs.summarize', 'metrics.query'],
          contextGrants: ['workspace_metadata', 'target_inventory'],
          approvalRequired: false
        }
      ],
      starterPrompt: 'Triage the selected cluster. Start by showing the compiled read scope.'
    },
    {
      id: 'repository-operation',
      workspaceId,
      version: 1,
      source: 'system',
      templateId: 'repository-operation',
      name: 'Repository operation',
      description: 'Prepare and apply a controlled configuration change in a selected repository.',
      status: 'active',
      category: 'git-operations',
      tags: ['git', 'repository', 'operations'],
      enabledMcpServers: ['github'],
      enabledSkills: ['acornops-cross-repo-change', 'acornops-open-pr'],
      inputs: [],
      requiredPermissions: ['read_workspace_data', 'create_read_write_runs'],
      policy: {
        mode: 'read_write',
        maxRuntimeSeconds: 1200,
        retentionDays: 90,
        approvalRequirements: ['Before creating branches or pull requests']
      },
      steps: [
        {
          id: 'inspect-repository-state',
          title: 'Inspect repository state',
          requiredInputs: [],
          enabledSkills: ['acornops-cross-repo-change'],
          allowedMcpServers: ['github'],
          allowedTools: ['github.repositories.read', 'github.branches.list', 'github.prs.list'],
          contextGrants: ['workspace_metadata'],
          approvalRequired: false
        },
        {
          id: 'prepare-git-change',
          title: 'Prepare Git change',
          requiredInputs: [],
          enabledSkills: ['acornops-open-pr'],
          allowedMcpServers: ['github'],
          allowedTools: ['github.branches.create', 'github.prs.create'],
          contextGrants: ['workspace_metadata'],
          approvalRequired: true,
          outputArtifacts: [{ id: 'patch-plan', type: 'patch', title: 'Repository change plan', required: true }]
        }
      ],
      starterPrompt: 'Prepare the selected repository operation and ask for approval before writing.'
    },
    {
      id: 'incident-report-pdf',
      workspaceId,
      version: 1,
      source: 'system',
      templateId: 'incident-report-pdf',
      name: 'Generate incident report from chats',
      description: 'Read selected cluster chats and generate a PDF incident report artifact.',
      status: 'active',
      category: 'incident-review',
      tags: ['incident', 'report', 'pdf'],
      enabledMcpServers: ['workspace-chat', 'artifact-writer'],
      enabledSkills: ['acornops-observability'],
      inputs: [],
      requiredPermissions: ['read_workspace_data', 'create_read_only_runs'],
      policy: {
        mode: 'read_only',
        maxRuntimeSeconds: 1500,
        retentionDays: 180,
        approvalRequirements: ['Before reading selected chats']
      },
      steps: [
        {
          id: 'generate-incident-report',
          title: 'Generate incident report',
          requiredInputs: [],
          enabledSkills: ['acornops-observability'],
          allowedMcpServers: ['workspace-chat', 'artifact-writer'],
          allowedTools: ['chat.sessions.read_selected', 'reports.pdf.generate'],
          contextGrants: ['selected_chat_sessions'],
          approvalRequired: true,
          outputArtifacts: [{ id: 'incident-report', type: 'pdf', title: 'Incident report PDF', required: true }]
        }
      ],
      starterPrompt: 'Generate a PDF incident report from the selected chats.'
    }
  ];
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

export function createWorkflowSession(params: {
  workflow: WorkflowDefinitionForAccess;
  createdBy: string;
  compiledAccessScope: CompiledWorkflowAccessScope;
}): WorkflowSessionRecord {
  const session: WorkflowSessionRecord = {
    id: randomUUID(),
    workflowId: params.workflow.id,
    workspaceId: params.workflow.workspaceId,
    workflowVersion: params.workflow.version,
    createdBy: params.createdBy,
    compiledAccessScope: params.compiledAccessScope,
    createdAt: new Date().toISOString()
  };
  workflowSessions.set(session.id, session);
  return session;
}

export function listWorkflowSessions(workflowId: string): WorkflowSessionRecord[] {
  return [...workflowSessions.values()]
    .filter((session) => session.workflowId === workflowId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getWorkflowSession(sessionId: string): WorkflowSessionRecord | null {
  return workflowSessions.get(sessionId) || null;
}

export function createWorkflowUserMessage(params: {
  session: WorkflowSessionRecord;
  content: string;
  inputs?: Record<string, unknown>;
}): WorkflowMessageRecord {
  const message: WorkflowMessageRecord = {
    id: randomUUID(),
    sessionId: params.session.id,
    workspaceId: params.session.workspaceId,
    workflowId: params.session.workflowId,
    role: 'user',
    content: params.content,
    inputs: params.inputs || {},
    createdAt: new Date().toISOString()
  };
  workflowMessages.set(message.id, message);
  return message;
}

export function createWorkflowRun(params: {
  session: WorkflowSessionRecord;
  message: WorkflowMessageRecord;
  workflowStepId?: string;
  llmProvider?: WorkflowRunRecord['llmProvider'];
  llmModel?: string;
  llmReasoningSummaryMode?: WorkflowRunRecord['llmReasoningSummaryMode'];
  llmReasoningEffort?: WorkflowRunRecord['llmReasoningEffort'];
}): WorkflowRunRecord {
  const now = new Date().toISOString();
  const approvalGates = params.session.compiledAccessScope.approvalGates;
  const run: WorkflowRunRecord = {
    id: randomUUID(),
    workflowRunId: randomUUID(),
    workspaceId: params.session.workspaceId,
    workflowId: params.session.workflowId,
    workflowSessionId: params.session.id,
    workflowStepId: params.workflowStepId,
    messageId: params.message.id,
    createdBy: params.session.createdBy,
    status: approvalGates.length > 0 ? 'waiting_for_approval' : 'queued',
    compiledAccessScope: params.session.compiledAccessScope,
    llmProvider: params.llmProvider,
    llmModel: params.llmModel,
    llmReasoningSummaryMode: params.llmReasoningSummaryMode,
    llmReasoningEffort: params.llmReasoningEffort,
    requestedAt: now,
    createdAt: now
  };
  workflowRuns.set(run.id, run);
  workflowMessages.set(params.message.id, { ...params.message, runId: run.id });
  for (const [index, gate] of approvalGates.entries()) {
    const approval: WorkflowApprovalRecord = {
      id: randomUUID(),
      runId: run.id,
      workspaceId: run.workspaceId,
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
      workflowSessionId: run.workflowSessionId,
      workflowStepId: run.workflowStepId,
      toolCallId: `workflow-gate-${index + 1}`,
      toolName: 'workflow.approval_gate',
      summary: gate,
      arguments: {
        workflowId: run.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: run.workflowSessionId,
        workflowStepId: run.workflowStepId || null
      },
      status: 'pending',
      executionStatus: 'not_started',
      requestedBy: run.createdBy,
      createdAt: now,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    };
    workflowApprovals.set(approval.id, approval);
  }
  return run;
}

export function getWorkflowRun(runId: string): WorkflowRunRecord | null {
  return workflowRuns.get(runId) || null;
}

export function listWorkflowRunsForSession(sessionId: string): WorkflowRunRecord[] {
  return [...workflowRuns.values()]
    .filter((run) => run.workflowSessionId === sessionId)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

export function listWorkflowRunApprovals(runId: string): WorkflowApprovalRecord[] {
  return [...workflowApprovals.values()]
    .filter((approval) => approval.runId === runId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function getWorkflowRunApproval(approvalId: string): WorkflowApprovalRecord | null {
  return workflowApprovals.get(approvalId) || null;
}

export function decideWorkflowRunApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): WorkflowApprovalRecord | null {
  const approval = workflowApprovals.get(approvalId);
  if (!approval) {
    return null;
  }
  if (approval.status !== 'pending') {
    return approval;
  }
  const now = new Date().toISOString();
  const status: ToolApprovalStatus = new Date(approval.expiresAt).getTime() <= Date.now()
    ? 'expired'
    : decision === 'approved'
      ? 'approved'
      : 'rejected';
  const updated: WorkflowApprovalRecord = {
    ...approval,
    status,
    decision: status === 'approved' || status === 'rejected' ? decision : approval.decision,
    decidedBy: status === 'approved' || status === 'rejected' ? decidedBy : approval.decidedBy,
    decidedAt: status === 'approved' || status === 'rejected' ? now : approval.decidedAt
  };
  workflowApprovals.set(approvalId, updated);
  return updated;
}

export function listWorkflowMessages(sessionId: string): WorkflowMessageRecord[] {
  return [...workflowMessages.values()]
    .filter((message) => message.sessionId === sessionId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function appendWorkflowRunEvents(runId: string, events: RunEvent[]): RunEvent[] {
  const run = workflowRuns.get(runId);
  if (!run) {
    return [];
  }
  const existingEvents = run.events || [];
  const nextEvents = [...existingEvents, ...events];
  workflowRuns.set(runId, { ...run, events: nextEvents, updatedAt: new Date().toISOString() });
  return events;
}

export function updateWorkflowRun(runId: string, update: Partial<Omit<WorkflowRunRecord, 'id'>>): WorkflowRunRecord | null {
  const run = workflowRuns.get(runId);
  if (!run) {
    return null;
  }
  const updated = { ...run, ...update, updatedAt: new Date().toISOString() };
  workflowRuns.set(runId, updated);
  return updated;
}

export function upsertWorkflowAssistantFinalMessage(params: {
  sessionId: string;
  runId: string;
  workspaceId: string;
  workflowId: string;
  content: string;
}): WorkflowMessageRecord {
  const existing = [...workflowMessages.values()].find(
    (message) => message.sessionId === params.sessionId && message.runId === params.runId && message.role === 'assistant'
  );
  const message: WorkflowMessageRecord = {
    id: existing?.id || randomUUID(),
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    role: 'assistant',
    content: params.content,
    inputs: {},
    runId: params.runId,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  workflowMessages.set(message.id, message);
  return message;
}

export function resetWorkflowRepositoryForTests(): void {
  workflowSessions.clear();
  workflowMessages.clear();
  workflowRuns.clear();
  workflowApprovals.clear();
  workflowDefinitionsByWorkspace.clear();
  workflowMcpServersByWorkspace.clear();
}
