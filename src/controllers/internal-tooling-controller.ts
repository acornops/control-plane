import { NextFunction, Request, Response } from 'express';
import { BuiltInToolSyncResult, syncTargetBuiltInTools } from '../services/target-built-in-tool-sync.js';
import { repo } from '../store/repository.js';

function isIncomplete(result: BuiltInToolSyncResult): boolean {
  return !result.ok || result.registeredToolCount === 0;
}

export async function syncTooling(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requestedWorkspaceId =
      typeof req.body?.workspaceId === 'string' && req.body.workspaceId.trim().length > 0 ? req.body.workspaceId : null;
    const requestedTargetId =
      typeof req.body?.targetId === 'string' && req.body.targetId.trim().length > 0 ? req.body.targetId : null;
    const requestedTargetType =
      typeof req.body?.targetType === 'string' && req.body.targetType.trim().length > 0 ? req.body.targetType : null;

    if (requestedWorkspaceId || requestedTargetId || requestedTargetType) {
      if (!requestedWorkspaceId || !requestedTargetId || !requestedTargetType) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'workspaceId, targetId, and targetType are required for targeted tooling sync',
            retryable: false
          }
        });
        return;
      }
      const target = await repo.getTarget(requestedWorkspaceId, requestedTargetId);
      if (!target) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
        return;
      }
      if (target.targetType !== requestedTargetType) {
        res.status(400).json({
          error: {
            code: 'TARGET_TYPE_MISMATCH',
            message: `Target ${requestedTargetId} is target_type=${target.targetType}, not ${requestedTargetType}`,
            retryable: false
          }
        });
        return;
      }
      const result = await syncTargetBuiltInTools(requestedWorkspaceId, requestedTargetId, target.targetType);
      if (isIncomplete(result)) {
        res.status(502).json({
          synced: 0,
          failed: 1,
          failures: [{
            workspaceId: result.workspaceId,
            targetId: result.targetId,
            targetType: result.targetType,
            reason: result.error || 'No built-in tools were registered in llm-gateway'
          }]
        });
        return;
      }
      res.status(200).json({ synced: 1, failed: 0 });
      return;
    }

    const registrations = await repo.listTargetAgentRegistrations();
    let synced = 0;
    const failures: Array<{ workspaceId: string; targetId: string; targetType: string; reason: string }> = [];
    for (const registration of registrations) {
      const result = await syncTargetBuiltInTools(registration.workspaceId, registration.targetId, registration.targetType);
      if (isIncomplete(result)) {
        failures.push({
          workspaceId: result.workspaceId,
          targetId: result.targetId,
          targetType: result.targetType,
          reason: result.error || 'No built-in tools were registered in llm-gateway'
        });
        continue;
      }
      synced += 1;
    }
    res.status(failures.length > 0 ? 207 : 200).json({ synced, failed: failures.length, failures });
  } catch (err) {
    next(err);
  }
}
