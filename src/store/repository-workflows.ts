import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type {
  WorkflowCapabilityPolicy,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import type { DefinitionOrigin } from '../types/agents.js';
import { resetWorkflowRunRepositoryForTests } from './repository-workflow-runs.js';

export type {
  WorkflowExecutionRecord,
  WorkflowMessageRecord,
  WorkflowRunRecord
} from './repository-workflow-runs.js';
export type { WorkflowSessionRecord } from './repository-workflow-sessions.js';
export type { WorkflowApprovalRecord } from './repository-workflow-run-approvals.js';
export {
  appendWorkflowRunEvents,
  createWorkflowExecution,
  createWorkflowRun,
  createWorkflowUserMessage,
  getWorkflowRun,
  listWorkflowMessages,
  listWorkflowExecutionAttempts,
  listWorkflowRunsForSession,
  updateWorkflowRun,
  updateWorkflowRunIfStatus,
  upsertWorkflowAssistantFinalMessage
} from './repository-workflow-runs.js';
export {
  createWorkflowSession,
  getWorkflowSession,
  listWorkflowSessions
} from './repository-workflow-sessions.js';
export {
  decideWorkflowRunApproval,
  decideWorkflowRunApprovalOutcome,
  getWorkflowRunApproval,
  listWorkflowApprovalsForWorkspace,
  listWorkflowRunApprovals
} from './repository-workflow-run-approvals.js';
export {
  createDelegatedWorkflowRun,
  listWorkflowChildRuns
} from './repository-workflow-run-delegations.js';
export {
  getWorkflowExecution,
  getWorkflowExecutionByClientRequestId,
  getWorkflowExecutionByTriggerOccurrence
} from './repository-workflow-execution-read.js';

export interface WorkflowDefinitionUpdate {
  name?: string;
  description?: string;
  status?: WorkflowDefinitionForAccess['status'];
  prompt?: string;
  agentIds?: string[];
  capabilityPolicy?: Partial<WorkflowCapabilityPolicy>;
  tags?: string[];
  requiredPermissions?: WorkflowDefinitionForAccess['requiredPermissions'];
}

export interface CreateWorkflowDefinitionInput {
  workspaceId: string;
  name: string;
  description?: string;
  prompt: string;
  agentIds: string[];
  capabilityPolicy: WorkflowCapabilityPolicy;
  tags?: string[];
  requiredPermissions?: WorkflowDefinitionForAccess['requiredPermissions'];
  createdBy: string;
  origin?: DefinitionOrigin;
  status?: WorkflowDefinitionForAccess['status'];
}

type WorkflowRow = QueryResultRow;
type Queryable = Pick<PoolClient, 'query'>;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function uniqueSorted(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeCapabilityPolicy(policy: WorkflowCapabilityPolicy): WorkflowCapabilityPolicy {
  if (!policy || (policy.restrictionMode !== 'inherit' && policy.restrictionMode !== 'restrict')) {
    throw new Error('Workflow capability policy must include a valid restrictionMode');
  }
  const restrictionMode = policy.restrictionMode;
  return {
    mode: policy.mode,
    restrictionMode,
    semanticCapabilityIds: restrictionMode === 'inherit' ? [] : uniqueSorted(policy.semanticCapabilityIds),
    contextGrants: uniqueSorted(policy.contextGrants),
    maxRuntimeSeconds: policy.maxRuntimeSeconds,
    retentionDays: policy.retentionDays,
    approvalRequirements: uniqueSorted(policy.approvalRequirements)
  };
}

function mapWorkflowDefinition(row: WorkflowRow): WorkflowDefinitionForAccess {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    origin: row.origin || { type: 'manual' },
    name: row.name,
    description: row.description || undefined,
    status: row.status,
    prompt: row.prompt,
    agentIds: row.agent_ids || [],
    executionMode: (row.agent_ids || []).length > 1 ? 'coordinated' : 'direct',
    capabilityPolicy: normalizeCapabilityPolicy(row.capability_policy),
    tags: row.tags || [],
    requiredPermissions: row.required_permissions || [],
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    readiness: {
      status: row.readiness_status || 'needs_setup',
      reasons: row.readiness_reasons || []
    }
  };
}

export async function listWorkflowDefinitions(workspaceId: string): Promise<WorkflowDefinitionForAccess[]> {
  const result = await db.query<WorkflowRow>(
    `SELECT * FROM workflow_definitions
     WHERE workspace_id=$1
     ORDER BY updated_at DESC,id`,
    [workspaceId]
  );
  return result.rows.map(mapWorkflowDefinition);
}

export async function getWorkflowDefinition(
  workspaceId: string,
  workflowId: string,
  queryable: Queryable = db
): Promise<WorkflowDefinitionForAccess | null> {
  const result = await queryable.query<WorkflowRow>(
    'SELECT * FROM workflow_definitions WHERE workspace_id=$1 AND id=$2',
    [workspaceId, workflowId]
  );
  return result.rowCount ? mapWorkflowDefinition(result.rows[0]) : null;
}

export async function createWorkflowDefinition(
  input: CreateWorkflowDefinitionInput,
  queryable: Queryable = db
): Promise<WorkflowDefinitionForAccess> {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workflow';
  const capabilityPolicy = normalizeCapabilityPolicy(input.capabilityPolicy);
  const agentIds = uniqueSorted(input.agentIds);
  const readiness = {
    status: 'needs_setup',
    reasons: ['Readiness has not been evaluated against the live capability catalog.']
  } as const;
  const result = await queryable.query<WorkflowRow>(
    `INSERT INTO workflow_definitions (
       workspace_id,id,origin,name,description,status,prompt,agent_ids,
       capability_policy,tags,required_permissions,created_by,readiness_status,readiness_reasons
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      input.workspaceId,
      `${slug}-${randomUUID().slice(0, 8)}`,
      input.origin || { type: 'manual' },
      input.name.trim(),
      input.description?.trim() || null,
      input.status || 'draft',
      input.prompt.trim(),
      JSON.stringify(agentIds),
      capabilityPolicy,
      JSON.stringify(uniqueSorted(input.tags)),
      JSON.stringify(uniqueSorted(input.requiredPermissions || []) as WorkflowDefinitionForAccess['requiredPermissions']),
      input.createdBy,
      readiness.status,
      JSON.stringify(readiness.reasons)
    ]
  );
  return mapWorkflowDefinition(result.rows[0]);
}

export async function duplicateWorkflowDefinition(
  workspaceId: string,
  workflowId: string,
  createdBy: string,
  requestedName?: string
): Promise<WorkflowDefinitionForAccess | null> {
  const source = await getWorkflowDefinition(workspaceId, workflowId);
  if (!source) return null;
  return createWorkflowDefinition({
    workspaceId,
    name: requestedName?.trim() || `${source.name} copy`,
    description: source.description,
    prompt: source.prompt,
    agentIds: source.agentIds,
    capabilityPolicy: source.capabilityPolicy,
    tags: source.tags,
    requiredPermissions: source.requiredPermissions,
    createdBy,
    origin: { type: 'manual' },
    status: 'draft'
  });
}

export async function updateWorkflowDefinitionScope(
  workspaceId: string,
  workflowId: string,
  update: WorkflowDefinitionUpdate,
  queryable: Queryable = db
): Promise<WorkflowDefinitionForAccess | null> {
  const current = await getWorkflowDefinition(workspaceId, workflowId, queryable);
  if (!current) return null;
  const capabilityPolicy = normalizeCapabilityPolicy({
    ...current.capabilityPolicy,
    ...update.capabilityPolicy
  });
  const result = await queryable.query<WorkflowRow>(
    `UPDATE workflow_definitions SET
       name=$3,description=$4,status=$5,prompt=$6,agent_ids=$7,
       capability_policy=$8,tags=$9,required_permissions=$10,
       readiness_status='needs_setup',readiness_reasons=$11,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [
      workspaceId,
      workflowId,
      update.name?.trim() || current.name,
      typeof update.description === 'string' ? update.description.trim() : current.description || null,
      update.status || current.status,
      update.prompt?.trim() || current.prompt,
      JSON.stringify(update.agentIds ? uniqueSorted(update.agentIds) : current.agentIds),
      capabilityPolicy,
      JSON.stringify(update.tags ? uniqueSorted(update.tags) : current.tags || []),
      JSON.stringify(update.requiredPermissions ? uniqueSorted(update.requiredPermissions) : current.requiredPermissions),
      JSON.stringify(['Readiness has not been evaluated against the live capability catalog.'])
    ]
  );
  return result.rowCount ? mapWorkflowDefinition(result.rows[0]) : null;
}

export async function updateWorkflowReadiness(
  workspaceId: string,
  workflowId: string,
  readiness: NonNullable<WorkflowDefinitionForAccess['readiness']>
): Promise<WorkflowDefinitionForAccess | null> {
  const result = await db.query<WorkflowRow>(
    `UPDATE workflow_definitions
     SET readiness_status=$3,readiness_reasons=$4,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2
       AND (readiness_status IS DISTINCT FROM $3 OR readiness_reasons IS DISTINCT FROM $4::jsonb)
     RETURNING *`,
    [workspaceId, workflowId, readiness.status, JSON.stringify(readiness.reasons)]
  );
  return result.rowCount ? mapWorkflowDefinition(result.rows[0]) : null;
}

export async function deleteWorkflowDefinition(workspaceId: string, workflowId: string): Promise<'deleted' | 'not_found'> {
  const result = await db.query(
    'DELETE FROM workflow_definitions WHERE workspace_id=$1 AND id=$2',
    [workspaceId, workflowId]
  );
  return result.rowCount ? 'deleted' : 'not_found';
}

export function resetWorkflowRepositoryForTests(): void {
  resetWorkflowRunRepositoryForTests();
}
