import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { CompiledWorkflowAccessScope } from '../types/workflows.js';
import {
  mapMessage,
  mapRun,
  type WorkflowExecutionRecord,
  type WorkflowMessageRecord,
  type WorkflowRunRecord
} from './repository-workflow-runs.js';

const iso = (value: unknown): string | undefined => value
  ? new Date(value as string).toISOString()
  : undefined;

function mapExecution(row: QueryResultRow): WorkflowExecutionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    workflowSessionId: row.workflow_session_id,
    messageId: row.message_id,
    createdBy: row.created_by,
    status: row.status,
    currentStepIndex: row.current_step_index,
    triggerType: row.trigger_type,
    triggerId: row.trigger_id || undefined,
    occurrenceKey: row.occurrence_key || undefined,
    clientRequestId: row.client_request_id || undefined,
    inputContext: row.input_context || {},
    requestProvenance: {
      actorType: row.request_actor_type || 'user',
      ...(row.request_external_integration_link_id
        ? { externalIntegrationLinkId: row.request_external_integration_link_id }
        : {}),
      ...(row.request_external_integration_client_id
        ? { externalIntegrationClientId: row.request_external_integration_client_id }
        : {})
    },
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    errorCode: row.error_code || undefined,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export async function getWorkflowExecution(executionId: string): Promise<WorkflowExecutionRecord | null> {
  const result = await db.query<QueryResultRow>('SELECT * FROM workflow_executions WHERE id=$1', [executionId]);
  return result.rowCount ? mapExecution(result.rows[0]) : null;
}

export async function getWorkflowExecutionByClientRequestId(
  workspaceId: string,
  clientRequestId: string
): Promise<{
  execution: WorkflowExecutionRecord;
  message: WorkflowMessageRecord;
  run: WorkflowRunRecord;
  compiledAccessScope: CompiledWorkflowAccessScope;
} | null> {
  const result = await db.query<QueryResultRow>(
    `SELECT execution.*,
            row_to_json(message) AS message_record,
            row_to_json(run_record) AS run_record,
            session.compiled_access_scope AS session_compiled_access_scope
       FROM workflow_executions execution
       JOIN workflow_messages message ON message.id=execution.message_id
       JOIN workflow_sessions session ON session.id=execution.workflow_session_id
       JOIN LATERAL (
         SELECT * FROM workflow_runs
          WHERE execution_id=execution.id
          ORDER BY step_index,attempt_number
          LIMIT 1
       ) run_record ON TRUE
      WHERE execution.workspace_id=$1 AND execution.client_request_id=$2`,
    [workspaceId, clientRequestId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    execution: mapExecution(row),
    message: mapMessage(row.message_record),
    run: mapRun(row.run_record, []),
    compiledAccessScope: row.session_compiled_access_scope
  };
}
