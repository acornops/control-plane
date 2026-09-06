import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { assertCapacityOwner, lockActiveWorkspace, lockReservation, WorkspaceCapacityError } from '../store/repository-run-capacity.js';
import { beginCapacityOperation, finishCapacityOperation } from '../store/repository-capacity-operations.js';
import { withTransaction } from '../store/repository-transaction.js';

export interface NativeExecutionAuthority {
  readonly ownerId: string;
  readonly generation: number;
}

/** Capture the caller's generation before asynchronous run/scope lookup. */
export function nativeExecutionAuthority(req: Request): NativeExecutionAuthority {
  return Object.freeze({
    ownerId: req.header?.('x-acornops-execution-owner') || '',
    generation: Number(req.header?.('x-acornops-execution-generation') || 0)
  });
}

interface NativeExecutionIdentity {
  readonly runId: string;
  readonly workspaceId: string;
  readonly authority?: NativeExecutionAuthority;
}

export async function withNativeExecutionAuthority<T>(
  input: NativeExecutionIdentity, work: (client: PoolClient) => Promise<T>
): Promise<T> {
  try {
    return await withTransaction(async (client) => {
      await lockActiveWorkspace(client, input.workspaceId);
      const run = await client.query<{ cancelled: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM workspace_lifecycle_outbox o WHERE o.workspace_id=r.workspace_id AND o.requested_at>=r.requested_at
        ) AS cancelled FROM (
          SELECT workspace_id,requested_at FROM runs WHERE id=$1 AND workspace_id=$2
          UNION ALL SELECT workspace_id,requested_at FROM workflow_runs WHERE id=$1 AND workspace_id=$2
        ) r`, [input.runId, input.workspaceId]);
      if (!run.rowCount) throw new WorkspaceCapacityError('NOT_FOUND', 'Run not found', 404);
      if (run.rows[0].cancelled) throw new WorkspaceCapacityError('RUN_CANCELLED_BY_SUSPENSION', 'This attempt was cancelled by workspace suspension', 409);
      if (config.WORKSPACE_CAPACITY_ENABLED) {
        const row = await lockReservation(client, input.runId);
        const authority = input.authority;
        if (!authority?.ownerId || !Number.isSafeInteger(authority.generation) || authority.generation <= 0) {
          throw new WorkspaceCapacityError('EXECUTION_AUTHORITY_LOST', 'Execution authority is no longer valid');
        }
        await assertCapacityOwner(client, row, authority.ownerId, authority.generation);
      }
      return work(client);
    });
  } catch (error) {
    if (error instanceof WorkspaceCapacityError) throw error;
    throw new WorkspaceCapacityError('WORKSPACE_CAPACITY_UNAVAILABLE', 'Workspace execution authority is temporarily unavailable', 503);
  }
}

/** Begin only after DNS; return cleanup bound to this exact owner and operation. */
export async function beginNativeFetchOperation(
  input: NativeExecutionIdentity, toolCallId: string, timeoutMs: number
): Promise<() => Promise<void>> {
  const operationId = `native-fetch:${toolCallId}`;
  const tracked = await withNativeExecutionAuthority(input, async (client) => {
    if (!config.WORKSPACE_CAPACITY_ENABLED) return false;
    await beginCapacityOperation(input.runId, input.authority!.ownerId, input.authority!.generation, operationId, timeoutMs, client);
    return true;
  });
  return async () => {
    if (tracked) await finishCapacityOperation(input.runId, input.authority!.ownerId, input.authority!.generation, operationId);
  };
}
