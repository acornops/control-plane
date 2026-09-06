import type { PoolClient } from 'pg';
import { config } from '../config.js';
import type { ExecutionPool } from '../types/workspace-policy.js';
import { effectiveWorkspaceLimits } from './repository-quotas.js';
import { withTransaction } from './repository-transaction.js';

export class WorkspaceCapacityError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkspaceCapacityError';
  }
}

export interface CapacityReservation {
  run_id: string;
  workspace_id: string;
  pool: ExecutionPool;
  state: 'queued' | 'executing' | 'parked' | 'settling' | 'settled';
  owner_id: string | null;
  generation: string | number;
  lease_expires_at: Date | null;
  executing_until: Date | null;
  queue_expires_at: Date;
  settled_at: Date | null;
}

export async function lockActiveWorkspace(client: Pick<PoolClient, 'query'>, workspaceId: string): Promise<string | null> {
  const workspace = await client.query<{ plan_key: string | null; lifecycle_status: string }>(
    'SELECT plan_key,lifecycle_status FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
  if (!workspace.rowCount) throw new WorkspaceCapacityError('NOT_FOUND', 'Workspace not found', 404);
  if (workspace.rows[0].lifecycle_status === 'suspended') {
    throw new WorkspaceCapacityError('WORKSPACE_SUSPENDED', 'Workspace suspended', 403);
  }
  return workspace.rows[0].plan_key;
}

export async function reserveRunCapacity(client: Pick<PoolClient, 'query'>, input: {
  workspaceId: string; runId: string; pool: ExecutionPool; eligibleAt?: Date;
}): Promise<void> {
  const planKey = await lockActiveWorkspace(client, input.workspaceId);
  const existing = await client.query<CapacityReservation>('SELECT * FROM workspace_run_reservations WHERE run_id=$1', [input.runId]);
  if (existing.rowCount) {
    if (existing.rows[0].workspace_id !== input.workspaceId || existing.rows[0].pool !== input.pool) {
      throw new WorkspaceCapacityError('IDEMPOTENCY_CONFLICT', 'Execution reservation identity conflicts');
    }
    return;
  }
  if (!config.WORKSPACE_ADMISSION_ENABLED) {
    throw new WorkspaceCapacityError('WORKSPACE_ADMISSION_PAUSED', 'Workspace admission is paused', 503);
  }
  const limit = effectiveWorkspaceLimits(planKey).executionLimits[input.pool].maxOutstandingRuns;
  const usage = await client.query<{ used: number }>(
    'SELECT count(*)::int AS used FROM workspace_run_reservations WHERE workspace_id=$1 AND pool=$2 AND settled_at IS NULL',
    [input.workspaceId, input.pool]);
  const used = usage.rows[0].used;
  if (config.WORKSPACE_CAPACITY_ENABLED && limit !== null && used >= limit) {
    throw new WorkspaceCapacityError('WORKSPACE_OUTSTANDING_RUN_LIMIT', 'The execution pool has no outstanding capacity', 409, { pool: input.pool, used, limit });
  }
  await client.query(
    `INSERT INTO workspace_run_reservations(run_id,workspace_id,pool,eligible_at,queue_expires_at)
     VALUES($1,$2,$3,COALESCE($4::timestamptz,clock_timestamp()),COALESCE($4::timestamptz,clock_timestamp())+($5::int*INTERVAL '1 second'))`,
    [input.runId, input.workspaceId, input.pool, input.eligibleAt || null, config.WORKSPACE_CAPACITY_QUEUE_SECONDS]);
}

export async function lockReservation(client: Pick<PoolClient, 'query'>, runId: string): Promise<CapacityReservation> {
  const identity = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_run_reservations WHERE run_id=$1', [runId]);
  if (!identity.rowCount) throw new WorkspaceCapacityError('WORKSPACE_CAPACITY_UNAVAILABLE', 'Execution reservation is missing', 503);
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [identity.rows[0].workspace_id]);
  const result = await client.query<CapacityReservation>('SELECT * FROM workspace_run_reservations WHERE run_id=$1 FOR UPDATE', [runId]);
  if (!result.rowCount) throw new WorkspaceCapacityError('NOT_FOUND', 'Execution reservation is unavailable', 404);
  return result.rows[0];
}

export async function assertCapacityOwner(client: Pick<PoolClient, 'query'>, row: CapacityReservation, owner: string, generation: number): Promise<void> {
  await lockActiveWorkspace(client, row.workspace_id);
  const alive = await client.query(`SELECT 1 FROM workspace_run_reservations r WHERE run_id=$1 AND lease_expires_at>clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM workspace_lifecycle_outbox o WHERE o.workspace_id=r.workspace_id AND o.requested_at>=r.created_at)`, [row.run_id]);
  if (row.state !== 'executing' || row.owner_id !== owner || Number(row.generation) !== generation || !alive.rowCount) {
    throw new WorkspaceCapacityError('EXECUTION_AUTHORITY_LOST', 'Execution authority is no longer valid', 409);
  }
}

export interface CapacityGrant {
  status: 'granted' | 'wait' | 'blocked';
  generation?: number;
  pool?: ExecutionPool;
  leaseSeconds?: number;
}

export async function acquireRunCapacity(runId: string, owner: string): Promise<CapacityGrant> {
  return withTransaction(async (client) => {
    const row = await lockReservation(client, runId);
    const planKey = await lockActiveWorkspace(client, row.workspace_id);
    const cancelled = await client.query(`SELECT 1 FROM workspace_lifecycle_outbox o JOIN workspace_run_reservations r
      ON r.workspace_id=o.workspace_id WHERE r.run_id=$1 AND o.requested_at>=r.created_at`, [runId]);
    if (cancelled.rowCount) return { status: 'blocked' };
    if (row.settled_at || row.state === 'settling') return { status: 'blocked' };
    if (row.state === 'executing') {
      if (row.owner_id !== owner) return { status: 'blocked' };
      try { await assertCapacityOwner(client, row, owner, Number(row.generation)); }
      catch (error) {
        if (error instanceof WorkspaceCapacityError) return { status: 'blocked' };
        throw error;
      }
      return { status: 'granted', generation: Number(row.generation), pool: row.pool, leaseSeconds: config.WORKSPACE_CAPACITY_LEASE_SECONDS };
    }
    if (!config.WORKSPACE_DISPATCH_ENABLED) return { status: 'wait', pool: row.pool };
    const expired = await client.query('SELECT 1 FROM workspace_run_reservations WHERE run_id=$1 AND queue_expires_at<=clock_timestamp()', [runId]);
    if (row.state === 'queued' && expired.rowCount) return { status: 'blocked' };
    const limit = effectiveWorkspaceLimits(planKey).executionLimits[row.pool].maxConcurrentRuns;
    const usage = await client.query<{ used: number }>(
      'SELECT count(*)::int AS used FROM workspace_run_reservations WHERE workspace_id=$1 AND pool=$2 AND executing_until IS NOT NULL', [row.workspace_id, row.pool]);
    if (config.WORKSPACE_CAPACITY_ENABLED && limit !== null && usage.rows[0].used >= limit) return { status: 'wait', pool: row.pool };
    const updated = await client.query<{ generation: string }>(
      `UPDATE workspace_run_reservations SET state='executing',owner_id=$2,generation=generation+1,
       lease_expires_at=clock_timestamp()+($3::int*INTERVAL '1 second'),executing_until=clock_timestamp()+($3::int*INTERVAL '1 second')
       WHERE run_id=$1 RETURNING generation`, [runId, owner, config.WORKSPACE_CAPACITY_LEASE_SECONDS]);
    return { status: 'granted', generation: Number(updated.rows[0].generation), pool: row.pool, leaseSeconds: config.WORKSPACE_CAPACITY_LEASE_SECONDS };
  });
}

export async function renewRunCapacity(runId: string, owner: string, generation: number): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockReservation(client, runId);
    await assertCapacityOwner(client, row, owner, generation);
    await client.query(`UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()+($2::int*INTERVAL '1 second'),
      executing_until=GREATEST(executing_until,clock_timestamp()+($2::int*INTERVAL '1 second')) WHERE run_id=$1`, [runId, config.WORKSPACE_CAPACITY_LEASE_SECONDS]);
  });
}

export async function releaseRunCapacity(runId: string, owner: string, generation: number, state: 'parked' | 'settling' = 'settling'): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockReservation(client, runId);
    if (row.owner_id !== owner || Number(row.generation) !== generation) throw new WorkspaceCapacityError('EXECUTION_AUTHORITY_LOST', 'Execution authority does not match');
    if (row.settled_at) return;
    if (state === 'parked') {
      if (row.state === 'parked') return;
      await assertCapacityOwner(client, row, owner, generation);
    }
    const active = await client.query('SELECT 1 FROM workspace_run_operations WHERE run_id=$1 AND finished_at IS NULL AND deadline>clock_timestamp()', [runId]);
    if (active.rowCount && state === 'parked') throw new WorkspaceCapacityError('EXECUTION_OPERATION_ACTIVE', 'Cannot park during an active operation');
    await client.query(`UPDATE workspace_run_reservations SET state=$2,lease_expires_at=NULL,
      executing_until=CASE WHEN $3 THEN executing_until ELSE NULL END WHERE run_id=$1`, [runId, state, Boolean(active.rowCount)]);
  });
}

export async function settleRunCapacity(runId: string): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockReservation(client, runId);
    if (row.settled_at) return;
    const operations = await client.query('SELECT 1 FROM workspace_run_operations WHERE run_id=$1 AND finished_at IS NULL AND deadline>clock_timestamp()', [runId]);
    const lease = await client.query('SELECT 1 FROM workspace_run_reservations WHERE run_id=$1 AND lease_expires_at>clock_timestamp()', [runId]);
    await client.query(`UPDATE workspace_run_reservations SET state=$2,
      settled_at=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END,
      executing_until=CASE WHEN $3 THEN executing_until ELSE NULL END WHERE run_id=$1`,
    [runId, operations.rowCount || lease.rowCount ? 'settling' : 'settled', Boolean(operations.rowCount || lease.rowCount)]);
  });
}

export { beginCapacityOperation, finishCapacityOperation } from './repository-capacity-operations.js';
