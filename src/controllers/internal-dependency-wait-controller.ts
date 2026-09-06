import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { withTransaction } from '../store/repository-transaction.js';
import { assertCapacityOwner, lockReservation, lockActiveWorkspace, WorkspaceCapacityError } from '../store/repository-run-capacity.js';

export async function saveDependencyWait(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = String(req.params.runId);
    await withTransaction(async (client) => {
      const reservation = await lockReservation(client, runId);
      await lockActiveWorkspace(client, reservation.workspace_id);
      if (config.WORKSPACE_CAPACITY_ENABLED) {
        await assertCapacityOwner(client, reservation, req.header('x-acornops-execution-owner') || '', req.body.generation);
      }
      const run = await client.query(`SELECT 1 FROM workflow_runs WHERE id=$1 AND executor_role='coordinator'
        AND parent_run_id IS NULL AND status IN ('running','dispatching') FOR UPDATE`, [runId]);
      if (!run.rowCount) throw new WorkspaceCapacityError('DELEGATION_PARENT_UNAVAILABLE', 'An active coordinator is required');
      await client.query(`INSERT INTO workflow_dependency_continuations(run_id,generation,state) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(run_id) DO UPDATE SET generation=EXCLUDED.generation,state=EXCLUDED.state,created_at=NOW()`,
      [runId, req.body.generation, JSON.stringify(req.body.state)]);
      if (!config.WORKSPACE_CAPACITY_ENABLED) await client.query("UPDATE workspace_run_reservations SET state='parked' WHERE run_id=$1", [runId]);
    });
    res.status(204).send();
  } catch (error) { next(error); }
}

export async function getDependencyContinuation(runId: string): Promise<Record<string, unknown> | null> {
  const result = await db.query('SELECT generation,state FROM workflow_dependency_continuations WHERE run_id=$1', [runId]);
  return result.rowCount ? { kind: 'dependency', runId, generation: Number(result.rows[0].generation), state: result.rows[0].state } : null;
}
export async function deleteDependencyContinuation(runId: string): Promise<void> {
  await db.query('DELETE FROM workflow_dependency_continuations WHERE run_id=$1', [runId]);
}
