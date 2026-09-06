import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { WorkspaceCapacityError } from '../store/repository-run-capacity.js';

export async function assertActiveWorkspace(workspaceId: string): Promise<void> {
  const result = await db.query<{ lifecycle_status: string }>('SELECT lifecycle_status FROM workspaces WHERE id=$1', [workspaceId]);
  if (!result.rowCount) throw new WorkspaceCapacityError('NOT_FOUND', 'Workspace not found', 404);
  if (result.rows[0].lifecycle_status === 'suspended') throw new WorkspaceCapacityError('WORKSPACE_SUSPENDED', 'Workspace suspended', 403);
}

export async function resolveExecutionIdentity(runId: string): Promise<{ workspaceId: string; requestedAt: string } | null> {
  const result = await db.query<{ workspace_id: string; requested_at: string }>(
    `SELECT workspace_id,requested_at::text AS requested_at FROM runs WHERE id=$1
     UNION ALL SELECT workspace_id,requested_at::text AS requested_at FROM workflow_runs WHERE id=$1
     UNION ALL SELECT workspace_id,created_at::text AS requested_at FROM workspace_run_reservations
       WHERE run_id=$1 AND pool='insights' LIMIT 1`, [runId]);
  return result.rowCount ? { workspaceId: result.rows[0].workspace_id, requestedAt: result.rows[0].requested_at } : null;
}

export async function assertExecutionActive(runId: string): Promise<void> {
  const identity = await resolveExecutionIdentity(runId);
  if (!identity) throw new WorkspaceCapacityError('NOT_FOUND', 'Run not found', 404);
  await assertActiveWorkspace(identity.workspaceId);
  const cancelled = await db.query(
    'SELECT 1 FROM workspace_lifecycle_outbox WHERE workspace_id=$1 AND requested_at >= $2', [identity.workspaceId, identity.requestedAt]);
  if (cancelled.rowCount) throw new WorkspaceCapacityError('RUN_CANCELLED_BY_SUSPENSION', 'This attempt was cancelled by workspace suspension', 409);
}

export function capacityErrorResponse(res: Response, error: unknown): void {
  const capacityError = error instanceof WorkspaceCapacityError ? error
    : new WorkspaceCapacityError('WORKSPACE_CAPACITY_UNAVAILABLE', 'Workspace execution authority is temporarily unavailable', 503);
  res.status(capacityError.status).json({ error: { code: capacityError.code, message: capacityError.message,
    retryable: ['WORKSPACE_CAPACITY_UNAVAILABLE', 'WORKSPACE_OUTSTANDING_RUN_LIMIT', 'WORKSPACE_ADMISSION_PAUSED'].includes(capacityError.code),
    ...(capacityError.details ? { details: capacityError.details } : {}) } });
}

/** Authenticated service routes may settle old work, but cannot start or revive it. */
export async function requireExecutionAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = String(res.locals.gatewayRunClaims?.runId || req.params.runId || req.body?.run_id || req.query.run_id || '');
    if (!runId) {
      if (req.params.sessionId) {
        const session = await db.query<{ workspace_id: string }>('SELECT workspace_id FROM sessions WHERE id=$1', [req.params.sessionId]);
        if (!session.rowCount) throw new WorkspaceCapacityError('NOT_FOUND', 'Session not found', 404);
        await assertActiveWorkspace(session.rows[0].workspace_id);
        if (config.WORKSPACE_CAPACITY_ENABLED) throw new WorkspaceCapacityError('EXECUTION_AUTHORITY_REQUIRED', 'Run identity is required', 403);
      }
      next(); return;
    }
    const cleanup = /\/(events|commit|event-cursor|tool-result-artifacts)$/.test(req.path)
      || /execution-finished$/.test(req.path) || (req.method === 'DELETE' && req.path.endsWith('/continuation'));
    if (!cleanup) await assertExecutionActive(runId);
    else {
      try { await assertExecutionActive(runId); }
      catch (error) {
        if (!(error instanceof WorkspaceCapacityError)) throw error;
        res.locals.executionCleanupOnly = true;
      }
    }
    if (config.WORKSPACE_CAPACITY_ENABLED && !req.path.includes('/capacity/')) {
      const row = await db.query<{ owner_id: string; generation: string; state: string; alive: boolean }>(
        'SELECT owner_id,generation,state,lease_expires_at>clock_timestamp() AS alive FROM workspace_run_reservations WHERE run_id=$1', [runId]);
      const current = row.rows[0];
      if (cleanup && (current?.state !== 'executing' || !current?.alive)) res.locals.executionCleanupOnly = true;
      if (!current || current.owner_id !== req.header('x-acornops-execution-owner')
        || String(current.generation) !== req.header('x-acornops-execution-generation')
        || (!cleanup && (current.state !== 'executing' || !current.alive))) {
        throw new WorkspaceCapacityError('EXECUTION_AUTHORITY_LOST', 'Execution authority is no longer valid');
      }
    }
    next();
  } catch (error) {
    capacityErrorResponse(res, error);
  }
}

export async function assertActiveTargetWorkspace(targetId: string): Promise<void> {
  const target = await db.query<{ workspace_id: string }>('SELECT workspace_id FROM targets WHERE id=$1', [targetId]);
  if (!target.rowCount) throw new WorkspaceCapacityError('NOT_FOUND', 'Target not found', 404);
  await assertActiveWorkspace(target.rows[0].workspace_id);
}
