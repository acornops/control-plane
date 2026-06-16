import { NextFunction, Response } from 'express';
import { agentGateway } from '../agent/ws-server.js';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { incrementAdminMutations } from '../metrics.js';
import { cancelRunInExecutionEngine } from '../services/execution-engine-client.js';
import { syncTargetBuiltInTools } from '../services/target-built-in-tool-sync.js';
import { emitRunStatusTransition } from '../services/webhooks.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, Run, TargetType, isTargetType } from '../types/domain.js';
import { generateAgentKey, hashSecret } from '../utils/crypto.js';
import { toSingleParam } from '../utils/params.js';
import { isRunTerminalStatus, terminalizeRunCancellation } from './run-cancellation.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../utils/pagination.js';
import {
  activeRun,
  auditAdmin,
  auditAdminMutationRequest,
  bestEffortWorkspaceAudit,
  notFound,
  parseBoolQuery,
  parseIsoDateQuery,
  parsePositiveIntQuery,
  safeRun,
  validationError
} from './admin-controller-common.js';

export async function listTargets(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const lastSeenBefore = parseIsoDateQuery(req.query.lastSeenBefore, 'lastSeenBefore');
    const lastSeenAfter = parseIsoDateQuery(req.query.lastSeenAfter, 'lastSeenAfter');
    if (lastSeenBefore.error || lastSeenAfter.error) {
      validationError(res, lastSeenBefore.error || lastSeenAfter.error!);
      return;
    }
    if (lastSeenAfter.value && lastSeenBefore.value && new Date(lastSeenAfter.value).getTime() > new Date(lastSeenBefore.value).getTime()) {
      validationError(res, 'lastSeenAfter must be earlier than or equal to lastSeenBefore');
      return;
    }
    const filters = {
      workspaceId: toSingleParam(req.query.workspaceId as string | string[] | undefined),
      targetType: toSingleParam(req.query.targetType as string | string[] | undefined) as TargetType | undefined,
      status: toSingleParam(req.query.status as string | string[] | undefined),
      q: normalizeSearchQuery(req.query.q),
      lastSeenBefore: lastSeenBefore.value,
      lastSeenAfter: lastSeenAfter.value
    };
    if (filters.targetType && !isTargetType(filters.targetType)) {
      validationError(res, 'targetType must be kubernetes or virtual_machine');
      return;
    }
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ createdAt: string; targetId: string; signature: string }>(req.query.cursor, signature);
    res.status(200).json(await repo.listAdminTargets({ limit: parseBoundedLimit(req.query.limit), cursor, signature, ...filters }));
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getTargetAgent(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = toSingleParam(req.params.targetId);
    const target = await repo.getTargetById(targetId);
    if (!target) {
      notFound(res, 'Target not found');
      return;
    }
    const reg = await repo.getTargetAgentRegistration(targetId);
    await auditAdmin(req, {
      action: 'admin.target.agent.read',
      workspaceId: target.workspaceId,
      targetType: target.targetType,
      targetId,
      metadata: { highRiskRead: true }
    });
    res.status(200).json({
      targetId,
      targetType: target.targetType,
      workspaceId: target.workspaceId,
      connectionState: target.status,
      keyVersion: reg?.keyVersion || null,
      lastHeartbeatAt: reg?.lastHeartbeatAt || null,
      lastConnectionId: reg?.lastConnectionId || null,
      owningControlPlaneInstance: null,
      agentVersion: reg?.lastAgentVersion || null,
      capabilities: reg?.capabilities || []
    });
  } catch (err) {
    next(err);
  }
}

export async function disconnectTargetAgent(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const targetId = toSingleParam(req.params.targetId);
    const target = await repo.getTargetById(targetId);
    if (!target) {
      notFound(res, 'Target not found');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.target.agent.disconnect',
      workspaceId: target.workspaceId,
      targetType: target.targetType,
      targetId,
      reason: req.body.reason,
      metadata: { ticketRef: req.body.ticketRef || null }
    });
    const disconnected = await agentGateway.disconnectCluster(targetId, 'Admin requested reconnect');
    await auditAdmin(req, {
      action: 'admin.target.agent.disconnect',
      workspaceId: target.workspaceId,
      targetType: target.targetType,
      targetId,
      reason: req.body.reason,
      metadata: { disconnected, ticketRef: req.body.ticketRef || null }
    });
    await bestEffortWorkspaceAudit({
      workspaceId: target.workspaceId,
      tokenId: req.admin.tokenId,
      category: 'target',
      eventType: 'agent.disconnected.v1',
      objectType: target.targetType,
      objectId: targetId,
      objectName: target.name,
      summary: 'Target agent disconnected by admin token',
      metadata: { reason: req.body.reason, disconnected, ticketRef: req.body.ticketRef || null }
    });
    res.status(200).json({ disconnected });
  } catch (err) {
    next(err);
  }
}

function installInstructions(targetId: string, targetType: TargetType, _agentKey: string): string {
  if (targetType === KUBERNETES_TARGET_TYPE) {
    return `Use the existing Kubernetes agent install flow with target ${targetId} and the returned one-time agent key.`;
  }
  return `Set ACORNOPS_TARGET_ID=${targetId} and ACORNOPS_AGENT_KEY to the returned one-time key, then restart the VM agent.`;
}

export async function rotateTargetAgentKey(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const targetId = toSingleParam(req.params.targetId);
    const target = await repo.getTargetById(targetId);
    if (!target) {
      notFound(res, 'Target not found');
      return;
    }
    const reg = await repo.getTargetAgentRegistration(targetId);
    if (!reg) {
      notFound(res, 'Agent registration not found');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.target.agent_key.rotate',
      workspaceId: target.workspaceId,
      targetType: target.targetType,
      targetId,
      reason: req.body.reason,
      metadata: { previousKeyVersion: reg.keyVersion, ticketRef: req.body.ticketRef || null }
    });
    const agentKey = generateAgentKey(targetId);
    const keyVersion = reg.keyVersion + 1;
    await repo.upsertTargetAgentRegistration({ ...reg, agentKeyHash: hashSecret(agentKey), keyVersion });
    const disconnected = await agentGateway.disconnectCluster(targetId, 'Agent key rotated');
    await auditAdmin(req, {
      action: 'admin.target.agent_key.rotate',
      workspaceId: target.workspaceId,
      targetType: target.targetType,
      targetId,
      reason: req.body.reason,
      metadata: { keyVersion, disconnected, ticketRef: req.body.ticketRef || null }
    });
    await bestEffortWorkspaceAudit({
      workspaceId: target.workspaceId,
      tokenId: req.admin.tokenId,
      category: 'target',
      eventType: 'agent.key_rotated.v1',
      objectType: target.targetType,
      objectId: targetId,
      objectName: target.name,
      summary: 'Target agent key rotated by admin token',
      metadata: { keyVersion, disconnected, reason: req.body.reason, ticketRef: req.body.ticketRef || null }
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ targetId, agentKey, keyVersion, installInstructions: installInstructions(targetId, target.targetType, agentKey) });
  } catch (err) {
    next(err);
  }
}

export async function listRuns(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const active = parseBoolQuery(req.query.active, 'active');
    if (active.error) {
      validationError(res, active.error);
      return;
    }
    const olderThanSeconds = parsePositiveIntQuery(req.query.olderThanSeconds, 'olderThanSeconds');
    if (olderThanSeconds.error) {
      validationError(res, olderThanSeconds.error);
      return;
    }
    const filters = {
      workspaceId: toSingleParam(req.query.workspaceId as string | string[] | undefined),
      targetId: toSingleParam(req.query.targetId as string | string[] | undefined),
      targetType: toSingleParam(req.query.targetType as string | string[] | undefined) as TargetType | undefined,
      sessionId: toSingleParam(req.query.sessionId as string | string[] | undefined),
      status: toSingleParam(req.query.status as string | string[] | undefined) as Run['status'] | undefined,
      requestedBy: toSingleParam(req.query.requestedBy as string | string[] | undefined),
      errorCode: toSingleParam(req.query.errorCode as string | string[] | undefined),
      active: active.value,
      olderThanSeconds: olderThanSeconds.value
    };
    if (filters.targetType && !isTargetType(filters.targetType)) {
      validationError(res, 'targetType must be kubernetes or virtual_machine');
      return;
    }
    if (filters.status && !['queued', 'dispatching', 'running', 'waiting_for_approval', 'completed', 'failed', 'cancelled', 'cancelling'].includes(filters.status)) {
      validationError(res, 'status must be a supported run status');
      return;
    }
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ requestedAt: string; runId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listAdminRuns({ limit: parseBoundedLimit(req.query.limit), cursor, signature, ...filters });
    res.status(200).json({ items: page.items.map(safeRun), nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getRun(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      notFound(res, 'Run not found');
      return;
    }
    await auditAdmin(req, { action: 'admin.run.detail.read', workspaceId: run.workspaceId, targetType: run.targetType, targetId: run.targetId, subjectType: 'run', subjectId: runId, metadata: { highRiskRead: true } });
    res.status(200).json(safeRun(run));
  } catch (err) {
    next(err);
  }
}

export async function cancelRun(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(202).json({ status: 'accepted' });
      return;
    }
    const previousStatus = run.status;
    await auditAdminMutationRequest(req, {
      action: 'admin.run.cancel',
      workspaceId: run.workspaceId,
      targetType: run.targetType,
      targetId: run.targetId,
      subjectType: 'run',
      subjectId: run.id,
      reason: req.body.reason,
      metadata: { previousStatus, ticketRef: req.body.ticketRef || null }
    });
    if (!isRunTerminalStatus(run.status)) {
      const shouldNotifyExecutionEngine = run.status !== 'waiting_for_approval' && activeRun(run.status);
      await terminalizeRunCancellation(run);
      if (shouldNotifyExecutionEngine) {
        await cancelRunInExecutionEngine(run.id).catch(() => undefined);
      }
    }
    await auditAdmin(req, { action: 'admin.run.cancel', workspaceId: run.workspaceId, targetType: run.targetType, targetId: run.targetId, subjectType: 'run', subjectId: run.id, reason: req.body.reason, metadata: { previousStatus, ticketRef: req.body.ticketRef || null } });
    await bestEffortWorkspaceAudit({ workspaceId: run.workspaceId, tokenId: req.admin.tokenId, category: 'run', eventType: 'run.cancel_requested.v1', objectType: 'run', objectId: run.id, summary: 'Run cancellation requested by admin token', metadata: { previousStatus, reason: req.body.reason, ticketRef: req.body.ticketRef || null } });
    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    next(err);
  }
}

export async function markRunFailed(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      notFound(res, 'Run not found');
      return;
    }
    if (activeRun(run.status) && !req.body.force) {
      res.status(409).json({ error: { code: 'RUN_ACTIVE', message: 'Cancel active runs before marking failed, or pass force=true', retryable: false } });
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.run.mark_failed',
      workspaceId: run.workspaceId,
      targetType: run.targetType,
      targetId: run.targetId,
      subjectType: 'run',
      subjectId: run.id,
      reason: req.body.reason,
      metadata: { previousStatus: run.status, force: req.body.force, errorCode: req.body.errorCode, ticketRef: req.body.ticketRef || null }
    });
    const updated = await repo.updateRun(run.id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      errorCode: req.body.errorCode,
      errorMessage: req.body.message
    });
    emitRunStatusTransition(run, updated);
    await auditAdmin(req, { action: 'admin.run.mark_failed', workspaceId: run.workspaceId, targetType: run.targetType, targetId: run.targetId, subjectType: 'run', subjectId: run.id, reason: req.body.reason, metadata: { previousStatus: run.status, force: req.body.force, errorCode: req.body.errorCode, ticketRef: req.body.ticketRef || null } });
    await bestEffortWorkspaceAudit({ workspaceId: run.workspaceId, tokenId: req.admin.tokenId, category: 'run', eventType: 'run.failed.v1', objectType: 'run', objectId: run.id, summary: 'Run marked failed by admin token', metadata: { previousStatus: run.status, force: req.body.force, errorCode: req.body.errorCode, reason: req.body.reason, ticketRef: req.body.ticketRef || null } });
    res.status(200).json(safeRun(updated || run));
  } catch (err) {
    next(err);
  }
}

export async function syncTooling(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = req.body.workspaceId as string | undefined;
    const targetId = req.body.targetId as string | undefined;
    const targetType = req.body.targetType as TargetType | undefined;
    let synced = 0;
    const failures: Array<Record<string, unknown>> = [];
    const syncOne = async (item: { workspaceId: string; targetId: string; targetType: TargetType }): Promise<void> => {
      try {
        const result = await syncTargetBuiltInTools(item.workspaceId, item.targetId, item.targetType);
        if (!result.ok || result.registeredToolCount === 0) {
          failures.push({
            targetId: item.targetId,
            targetType: item.targetType,
            message: result.error || 'No built-in tools were registered in llm-gateway'
          });
          return;
        }
        synced += 1;
      } catch (err) {
        failures.push({ targetId: item.targetId, targetType: item.targetType, message: err instanceof Error ? err.message : 'Sync failed' });
      }
    };
    if (workspaceId || targetId || targetType) {
      if (!workspaceId || !targetId || !targetType) {
        validationError(res, 'workspaceId, targetId, and targetType are required for targeted tooling sync');
        return;
      }
      const target = await repo.getTarget(workspaceId, targetId);
      if (!target || target.targetType !== targetType) {
        notFound(res, 'Target not found');
        return;
      }
      await auditAdminMutationRequest(req, {
        action: 'admin.tooling.sync',
        workspaceId,
        targetType,
        targetId,
        reason: req.body.reason,
        metadata: { scope: 'target', ticketRef: req.body.ticketRef || null }
      });
      await syncOne({ workspaceId, targetId, targetType });
    } else {
      await auditAdminMutationRequest(req, {
        action: 'admin.tooling.sync',
        reason: req.body.reason,
        metadata: { scope: 'all_targets', ticketRef: req.body.ticketRef || null }
      });
      for (const registration of await repo.listTargetAgentRegistrations()) {
        await syncOne(registration);
      }
    }
    await auditAdmin(req, { action: 'admin.tooling.sync', workspaceId, targetType, targetId, reason: req.body.reason, metadata: { synced, failures, ticketRef: req.body.ticketRef || null } });
    if (workspaceId && targetId && targetType) {
      await bestEffortWorkspaceAudit({
        workspaceId,
        tokenId: req.admin.tokenId,
        category: 'tool',
        eventType: 'tool.catalog.changed.v1',
        objectType: targetType,
        objectId: targetId,
        summary: 'Target tooling synchronized by admin token',
        metadata: { synced, failureCount: failures.length, reason: req.body.reason, ticketRef: req.body.ticketRef || null }
      });
    }
    res.status(failures.length ? 207 : 200).json({ synced, failures });
  } catch (err) {
    next(err);
  }
}
