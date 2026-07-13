import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { resetWorkflowRunRepositoryForTests } from './repository-workflow-runs.js';
export type { WorkflowApprovalRecord, WorkflowExecutionRecord, WorkflowMessageRecord, WorkflowRunRecord, WorkflowSessionRecord } from './repository-workflow-runs.js';
export { appendWorkflowRunEvents, createWorkflowExecution, createWorkflowRun, createWorkflowSession, createWorkflowUserMessage, decideWorkflowRunApproval, getWorkflowRun, getWorkflowRunApproval, getWorkflowSession, listWorkflowApprovalsForWorkspace, listWorkflowMessages, listWorkflowRunApprovals, listWorkflowRunsForSession, listWorkflowSessions, updateWorkflowRun, upsertWorkflowAssistantFinalMessage } from './repository-workflow-runs.js';
export { getWorkflowOptionsCatalog } from './repository-workflow-options.js';
export { createWorkflowMcpServer, deleteWorkflowMcpServer, listWorkflowMcpServerTools, listWorkflowMcpServers, testWorkflowMcpServerConnection, updateWorkflowMcpServer } from './repository-workflow-mcp.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowCategory,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
  WorkflowStepDefinition
} from '../types/workflows.js';

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

type WorkflowRow = QueryResultRow;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapWorkflowDefinition(row: WorkflowRow): WorkflowDefinitionForAccess {
  return {
    id: row.id, workspaceId: row.workspace_id, version: row.version, source: row.source,
    templateId: row.template_id || undefined, name: row.name, description: row.description || undefined,
    status: row.status, category: row.category, orchestratorAgentId: row.orchestrator_agent_id,
    tags: row.tags || [], inputs: row.inputs || [], enabledMcpServers: row.enabled_mcp_servers || [],
    enabledSkills: row.enabled_skills || [], requiredPermissions: row.required_permissions || [],
    policy: row.policy, steps: row.steps, starterPrompt: row.starter_prompt || undefined,
    createdBy: row.created_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    readiness: { status: row.readiness_status || 'needs_setup', reasons: row.readiness_reasons || [] }
  };
}

export async function listWorkflowDefinitions(workspaceId: string): Promise<WorkflowDefinitionForAccess[]> {
  const result = await db.query<WorkflowRow>(
    'SELECT * FROM workflow_definitions WHERE workspace_id=$1 ORDER BY updated_at DESC,id', [workspaceId]
  );
  return result.rows.map(mapWorkflowDefinition);
}

export async function getWorkflowDefinition(workspaceId: string, workflowId: string): Promise<WorkflowDefinitionForAccess | null> {
  const result = await db.query<WorkflowRow>('SELECT * FROM workflow_definitions WHERE workspace_id=$1 AND id=$2', [workspaceId, workflowId]);
  return result.rowCount ? mapWorkflowDefinition(result.rows[0]) : null;
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

export async function createWorkflowDefinition(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinitionForAccess> {
  const id = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || `workflow-${randomUUID()}`;
  const candidateId = `${id}-${randomUUID().slice(0, 8)}`;
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    starterPrompt: input.starterPrompt?.trim()
  };
  const result = await db.query<WorkflowRow>(
    `INSERT INTO workflow_definitions (
      workspace_id,id,version,source,name,description,status,category,orchestrator_agent_id,tags,inputs,
      enabled_mcp_servers,enabled_skills,required_permissions,policy,steps,starter_prompt,created_by,
      readiness_status,readiness_reasons
     ) VALUES ($1,$2,1,'user',$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ready','[]') RETURNING *`,
    [input.workspaceId, definition.id, definition.name, definition.description || null, definition.category,
     definition.orchestratorAgentId, JSON.stringify(definition.tags), JSON.stringify(definition.inputs), JSON.stringify(definition.enabledMcpServers),
     JSON.stringify(definition.enabledSkills), JSON.stringify(definition.requiredPermissions), definition.policy, JSON.stringify(definition.steps),
     definition.starterPrompt || null, input.createdBy]
  );
  return mapWorkflowDefinition(result.rows[0]);
}

export async function updateWorkflowDefinitionScope(
  workspaceId: string,
  workflowId: string,
  update: WorkflowDefinitionScopeUpdate
): Promise<WorkflowDefinitionForAccess | null> {
  const current = await getWorkflowDefinition(workspaceId, workflowId);
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
    updatedAt: new Date().toISOString()
  };
  const result = await db.query<WorkflowRow>(
    `UPDATE workflow_definitions SET version=version+1,name=$3,description=$4,status=$5,category=$6,tags=$7,
      inputs=$8,enabled_mcp_servers=$9,enabled_skills=$10,required_permissions=$11,policy=$12,steps=$13,
      starter_prompt=$14,updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, workflowId, updated.name, updated.description || null, updated.status, updated.category,
     JSON.stringify(updated.tags || []), JSON.stringify(updated.inputs || []), JSON.stringify(updated.enabledMcpServers || []), JSON.stringify(updated.enabledSkills || []),
     JSON.stringify(updated.requiredPermissions), updated.policy, JSON.stringify(updated.steps), updated.starterPrompt || null]
  );
  return result.rowCount ? mapWorkflowDefinition(result.rows[0]) : null;
}

export async function deleteWorkflowDefinition(workspaceId: string, workflowId: string): Promise<'deleted' | 'system' | 'not_found'> {
  const current = await getWorkflowDefinition(workspaceId, workflowId);
  if (!current) return 'not_found';
  if ((current.source || 'system') === 'system') return 'system';
  await db.query('DELETE FROM workflow_definitions WHERE workspace_id=$1 AND id=$2', [workspaceId, workflowId]);
  return 'deleted';
}

export function resetWorkflowRepositoryForTests(): void {
  resetWorkflowRunRepositoryForTests();
}
