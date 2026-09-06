import type { PoolClient } from 'pg';
import { withTransaction } from './repository-transaction.js';
import { assertCapacityOwner, lockReservation, WorkspaceCapacityError } from './repository-run-capacity.js';

export async function beginCapacityOperation(runId: string, owner: string, generation: number, operationId: string, timeoutMs: number, transaction?: PoolClient): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new WorkspaceCapacityError('VALIDATION_ERROR', 'Operation deadline is invalid', 400);
  const begin = async (client: PoolClient) => {
    const row = await lockReservation(client, runId);
    await assertCapacityOwner(client, row, owner, generation);
    const result = await client.query(`INSERT INTO workspace_run_operations(run_id,generation,operation_id,owner_id,deadline)
      VALUES($1,$2,$3,$4,clock_timestamp()+($5::int*INTERVAL '1 millisecond')) ON CONFLICT DO NOTHING RETURNING operation_id`,
    [runId, generation, operationId, owner, timeoutMs]);
    if (!result.rowCount) throw new WorkspaceCapacityError('EXECUTION_OPERATION_REPLAY', 'Operation was already dispatched; do not repeat it');
    await client.query(`UPDATE workspace_run_reservations SET executing_until=GREATEST(executing_until,
      clock_timestamp()+($2::int*INTERVAL '1 millisecond')) WHERE run_id=$1`, [runId, timeoutMs]);
  };
  if (transaction) await begin(transaction);
  else await withTransaction(begin);
}

export async function finishCapacityOperation(runId: string, owner: string, generation: number, operationId: string): Promise<void> {
  await withTransaction(async (client) => {
    await lockReservation(client, runId);
    await client.query(`UPDATE workspace_run_operations SET finished_at=COALESCE(finished_at,clock_timestamp())
      WHERE run_id=$1 AND generation=$2 AND operation_id=$3 AND owner_id=$4`, [runId, generation, operationId, owner]);
  });
}
