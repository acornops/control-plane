import { randomUUID } from 'node:crypto';
import { defaultWorkflowDefinitions } from './repository-workflow-defaults.js';
import { resetWorkflowRunRepositoryForTests } from './repository-workflow-runs.js';
export type { WorkflowApprovalRecord, WorkflowMessageRecord, WorkflowRunRecord, WorkflowSessionRecord } from './repository-workflow-runs.js';
export { appendWorkflowRunEvents, createWorkflowRun, createWorkflowSession, createWorkflowUserMessage, decideWorkflowRunApproval, getWorkflowRun, getWorkflowRunApproval, getWorkflowSession, listWorkflowApprovalsForWorkspace, listWorkflowMessages, listWorkflowRunApprovals, listWorkflowRunsForSession, listWorkflowSessions, updateWorkflowRun, upsertWorkflowAssistantFinalMessage } from './repository-workflow-runs.js';
export { getWorkflowOptionsCatalog } from './repository-workflow-options.js';
export { createWorkflowMcpServer, deleteWorkflowMcpServer, listWorkflowMcpServerTools, listWorkflowMcpServers, testWorkflowMcpServerConnection, updateWorkflowMcpServer } from './repository-workflow-mcp.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowCategory,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
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
  authHeaderName?: string;
  scope: 'workspace';
  credentialConfigured: boolean;
  publicHeaders: Record<string, string>;
  status: 'connected' | 'disabled' | 'not_checked' | 'error';
  lastCheckedAt?: string;
  discoveryError?: string;
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
    credential?: string;
    headerName?: string;
  };
  publicHeaders?: Record<string, string>;
  createdBy: string;
}

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

export function resetWorkflowRepositoryForTests(): void {
  resetWorkflowRunRepositoryForTests();
  workflowDefinitionsByWorkspace.clear();
}
