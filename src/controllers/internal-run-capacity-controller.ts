import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireServiceToken } from '../auth/middleware.js';
import { validateBody } from '../utils/http.js';
import { acquireRunCapacity, renewRunCapacity, releaseRunCapacity, WorkspaceCapacityError } from '../store/repository-run-capacity.js';
import { beginCapacityOperation, finishCapacityOperation } from '../store/repository-capacity-operations.js';
import { assertExecutionActive, resolveExecutionIdentity, capacityErrorResponse } from '../services/workspace-execution-access.js';

const owner = z.object({ ownerId: z.string().min(1).max(200) });
const grant = owner.extend({ generation: z.number().int().positive() });
const operation = grant.extend({ operationId: z.string().min(1).max(200) });
export function registerRunCapacityRoutes(router: Router): void {
  const routes = [
    ['authorize', z.object({ workspaceId: z.string().min(1) }).strict()], ['acquire', owner.strict()], ['renew', grant.strict()],
    ['release', grant.extend({ state: z.enum(['parked', 'settling']).default('settling') }).strict()],
    ['operations/begin', operation.extend({ timeoutMs: z.number().int().positive().max(3600000) }).strict()],
    ['operations/finish', operation.strict()]
  ] as const;
  for (const [action, schema] of routes) {
    router.post(`/runs/:runId/capacity/${action}`, requireServiceToken, validateBody<unknown>(schema), async (req, res) => {
      try {
        const runId = String(req.params.runId);
        if (!['release', 'operations/finish'].includes(action)) await assertExecutionActive(runId);
        if (action === 'authorize') {
          const identity = await resolveExecutionIdentity(runId);
          if (identity?.workspaceId !== req.body.workspaceId) throw new WorkspaceCapacityError('FORBIDDEN', 'Run workspace does not match', 403);
          res.json({ status: 'ok', capacityEnabled: config.WORKSPACE_CAPACITY_ENABLED, contractVersion: 1 });
          return;
        }
        if (!config.WORKSPACE_CAPACITY_ENABLED && action === 'acquire' && !config.WORKSPACE_DISPATCH_ENABLED) {
          res.json({ status: 'wait', contractVersion: 1 }); return;
        }
        if (!config.WORKSPACE_CAPACITY_ENABLED) { res.json({ status: 'disabled', contractVersion: 1 }); return; }
        const { ownerId, generation, operationId, timeoutMs, state } = req.body;
        if (action === 'acquire') { res.json({ ...await acquireRunCapacity(runId, ownerId), contractVersion: 1 }); return; }
        if (action === 'renew') await renewRunCapacity(runId, ownerId, generation);
        if (action === 'release') await releaseRunCapacity(runId, ownerId, generation, state);
        if (action === 'operations/begin') await beginCapacityOperation(runId, ownerId, generation, operationId, timeoutMs);
        if (action === 'operations/finish') await finishCapacityOperation(runId, ownerId, generation, operationId);
        res.json({ status: 'ok', contractVersion: 1 });
      } catch (error) {
        capacityErrorResponse(res, error);
      }
    });
  }
}
