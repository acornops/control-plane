import { config } from '../config.js';
import { db } from '../infra/db.js';
import { executionAdmissionTimeSql } from '../store/repository-execution-admission.js';
import { AgentToolCallError } from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentExecutionContext {
  runId: string;
  workspaceId: string;
  ownerId: string;
  generation: number;
}
const execution = new AsyncLocalStorage<AgentExecutionContext>();

export function currentAgentExecution(): AgentExecutionContext | undefined { return execution.getStore(); }
export function withAgentExecution<T>(context: AgentExecutionContext | undefined, work: () => Promise<T>): Promise<T> {
  return context ? execution.run(context, work) : work();
}

/** Read durable cancellation and current authority again immediately before dispatch. */
export async function assertAgentExecutionAllowed(): Promise<void> {
  const context = currentAgentExecution();
  if (!context) return;
  const result = await db.query<{
    status: string; cancellation_requested_at: unknown; lifecycle_status: string; suspended: boolean;
    owner_id: string | null; generation: string | null; state: string | null; alive: boolean | null;
  }>(`SELECT r.status,r.cancellation_requested_at,w.lifecycle_status,
      EXISTS(SELECT 1 FROM workspace_lifecycle_outbox o WHERE o.workspace_id=r.workspace_id
        AND o.requested_at>=${executionAdmissionTimeSql('r')}) AS suspended,
      c.owner_id,c.generation,c.state,c.lease_expires_at>clock_timestamp() AS alive
    FROM (
      SELECT id,workspace_id,status,NULL::timestamptz AS cancellation_requested_at FROM runs WHERE id=$1
      UNION ALL SELECT id,workspace_id,status,cancellation_requested_at FROM workflow_runs WHERE id=$1
    ) r JOIN workspaces w ON w.id=r.workspace_id
    LEFT JOIN workspace_run_reservations c ON c.run_id=r.id AND c.workspace_id=r.workspace_id
    WHERE r.workspace_id=$2`, [context.runId, context.workspaceId]);
  const row = result.rows[0];
  if (!row || !['dispatching', 'running', 'waiting_for_approval'].includes(row.status)
    || row.cancellation_requested_at || row.suspended || row.lifecycle_status === 'suspended') {
    throw new AgentToolCallError('Run is no longer active for agent dispatch', -32000, { code: 'RUN_NOT_ACTIVE', outcome: 'not_started' });
  }
  if (config.WORKSPACE_CAPACITY_ENABLED && (!context.ownerId || !Number.isSafeInteger(context.generation)
    || context.generation <= 0 || row.owner_id !== context.ownerId || Number(row.generation) !== context.generation
    || row.state !== 'executing' || !row.alive)) {
    throw new AgentToolCallError('Execution authority is no longer valid', -32000, { code: 'EXECUTION_AUTHORITY_LOST', outcome: 'not_started' });
  }
}
