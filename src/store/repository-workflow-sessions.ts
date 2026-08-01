import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import type { RunRequestProvenance } from './repository-run-provenance.js';

export interface WorkflowSessionRecord {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowSnapshot: WorkflowDefinitionForAccess;
  createdBy: string;
  requestProvenance: RunRequestProvenance;
  compiledAccessScope: CompiledWorkflowAccessScope;
  launchedAt?: string;
  createdAt: string;
}

type Row = QueryResultRow;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapSession(row: Row): WorkflowSessionRecord {
  return {
    id: row.id, workflowId: row.workflow_id, workspaceId: row.workspace_id,
    createdBy: row.created_by,
    workflowSnapshot: row.workflow_snapshot,
    requestProvenance: {
      actorType: row.request_actor_type || 'user',
      ...(row.request_external_integration_link_id ? { externalIntegrationLinkId: row.request_external_integration_link_id } : {}),
      ...(row.request_external_integration_client_id ? { externalIntegrationClientId: row.request_external_integration_client_id } : {})
    },
    compiledAccessScope: row.compiled_access_scope,
    launchedAt: iso(row.launched_at),
    createdAt: iso(row.created_at)!
  };
}

export async function createWorkflowSession(params: {
  workflow: WorkflowDefinitionForAccess;
  createdBy: string;
  compiledAccessScope: CompiledWorkflowAccessScope;
  requestProvenance?: RunRequestProvenance;
  sessionId?: string;
}): Promise<WorkflowSessionRecord> {
  const provenance = params.requestProvenance || { actorType: 'user' };
  const result = await db.query<Row>(
    `INSERT INTO workflow_sessions (
       id,workspace_id,workflow_id,created_by,compiled_access_scope,workflow_snapshot,
       request_actor_type,request_external_integration_link_id,request_external_integration_client_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [params.sessionId || randomUUID(), params.workflow.workspaceId, params.workflow.id,
     params.createdBy, params.compiledAccessScope, params.workflow, provenance.actorType,
     provenance.externalIntegrationLinkId || null, provenance.externalIntegrationClientId || null]
  );
  return mapSession(result.rows[0]);
}

export async function listWorkflowSessions(
  workspaceId: string,
  workflowId: string
): Promise<WorkflowSessionRecord[]> {
  const result = await db.query<Row>(
    `SELECT * FROM workflow_sessions WHERE workspace_id=$1 AND workflow_id=$2 ORDER BY created_at DESC,id DESC`,
    [workspaceId, workflowId]
  );
  return result.rows.map(mapSession);
}

export async function getWorkflowSession(sessionId: string): Promise<WorkflowSessionRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_sessions WHERE id=$1', [sessionId]);
  return result.rowCount ? mapSession(result.rows[0]) : null;
}
