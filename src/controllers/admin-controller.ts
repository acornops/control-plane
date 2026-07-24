import { randomUUID } from 'node:crypto';
import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { countUserSessions, revokeUserSessionsWithCount } from '../auth/session.js';
import { isSupportedRole } from '../auth/authorization.js';
import { config } from '../config.js';
import { checkDatabaseHealth } from '../infra/db.js';
import { checkRedisHealth } from '../infra/redis.js';
import { repo } from '../store/repository.js';
import { QuotaExceededError, effectiveWorkspaceLimits, resolveWorkspacePlan } from '../store/repository-quotas.js';
import { toSingleParam } from '../utils/params.js';
import { CursorMismatchError, decodeCursor, makeQuerySignature, normalizeSearchQuery, parseBoundedLimit } from '../utils/pagination.js';
import { incrementAdminMutations } from '../metrics.js';
import { cleanupRemovedMemberMcpConnections } from '../services/mcp-secret-cleanup-worker.js';
import {
  auditAdmin,
  auditAdminMutationRequest,
  bestEffortWorkspaceAudit,
  notFound,
  parseBoolQuery,
  parseIsoDateQuery,
  parseStringFilter,
  validationError
} from './admin-controller-common.js';
import { membershipAudit } from './admin-membership-audit.js';
export * from './admin-target-run-controller.js';
export * from './admin-audit-controller.js';
export * from './admin-workspace-lifecycle-controller.js';
export * from './admin-workspace-member-search-controller.js';

export async function me(req: AdminAuthenticatedRequest, res: Response): Promise<void> {
  res.status(200).json({
    tokenId: req.admin.tokenId,
    ...(req.admin.tokenName ? { tokenName: req.admin.tokenName } : {}),
    scopes: req.admin.scopes,
    ...(req.admin.actor ? {
      actor: {
        issuer: req.admin.actor.issuer,
        subject: req.admin.actor.subject,
        email: req.admin.actor.email,
        displayName: req.admin.actor.displayName,
        roles: req.admin.actor.roles,
        scopes: req.admin.actor.scopes,
        authenticatedAt: new Date(req.admin.actor.authenticatedAt).toISOString()
      }
    } : {}),
    adminApiEnabled: true
  });
}

export async function systemReadiness(_req: AdminAuthenticatedRequest, res: Response): Promise<void> {
  const [postgres, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
  res.status(postgres && redis ? 200 : 503).json({
    status: postgres && redis ? 'ok' : 'degraded',
    dependencies: {
      postgres: postgres ? 'ok' : 'down',
      redis: redis ? 'ok' : 'down',
      executionEngine: 'configured',
      llmGateway: 'configured',
      migrations: 'checked_on_startup',
      runEventPersistence: config.PERSIST_RUN_EVENTS ? 'enabled' : 'disabled',
      jwksSigningConfig: config.GATEWAY_SIGNING_PRIVATE_KEY_PEM || config.GATEWAY_SIGNING_PRIVATE_KEY_PEM_B64 ? 'present' : 'missing',
      adminAuditWrite: 'configured'
    },
    warnings: config.WORKSPACE_PLANS.plans.length === 0 ? ['No workspace plans configured'] : []
  });
}

export async function systemConfig(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await auditAdmin(req, { action: 'admin.system.config.read', metadata: { highRiskRead: true } });
    res.status(200).json({
      adminApiEnabled: config.CONTROL_PLANE_ADMIN_API_ENABLED,
      planCatalog: config.WORKSPACE_PLANS,
      roleTemplateKeys: config.WORKSPACE_ROLE_TEMPLATES.map((role) => role.key),
      authModes: {
        password: config.PASSWORD_AUTH_ENABLED,
        oidcProvider: config.OIDC_PROVIDER_NAME
      },
      retention: {
        conversationDays: config.CONVERSATION_RETENTION_DAYS,
        webhookHistoryDays: config.WEBHOOK_HISTORY_RETENTION_DAYS,
        workspaceAuditDays: config.WORKSPACE_AUDIT_RETENTION_DAYS,
        targetMetricHistoryDays: config.TARGET_METRIC_HISTORY_RETENTION_DAYS,
        skillSnapshotBlobOrphanGraceDays: config.SKILL_SNAPSHOT_BLOB_ORPHAN_GRACE_DAYS
      },
      auditLogging: {
        mode: config.WORKSPACE_AUDIT_LOGGING_MODE
      },
      runPolicy: {
        maxRuntimeMs: config.ASSISTANT_MAX_RUNTIME_MS,
        maxSteps: config.ASSISTANT_MAX_STEPS,
        maxToolCalls: config.ASSISTANT_MAX_TOOL_CALLS,
        writeConfirmationRequired: config.ASSISTANT_WRITE_CONFIRMATION_REQUIRED
      },
      featureFlags: {
        distributedRouting: config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED,
        persistRunEvents: config.PERSIST_RUN_EVENTS,
        internalTransportTls: config.INTERNAL_TRANSPORT_TLS_ENABLED
      }
    });
  } catch (err) {
    next(err);
  }
}

export async function listWorkspaces(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = normalizeSearchQuery(req.query.q);
    const overLimit = parseBoolQuery(req.query.overLimit, 'overLimit');
    const createdAfter = parseIsoDateQuery(req.query.createdAfter, 'createdAfter');
    const createdBefore = parseIsoDateQuery(req.query.createdBefore, 'createdBefore');
    if (overLimit.error || createdAfter.error || createdBefore.error) {
      validationError(res, overLimit.error || createdAfter.error || createdBefore.error!);
      return;
    }
    if (createdAfter.value && createdBefore.value && new Date(createdAfter.value).getTime() > new Date(createdBefore.value).getTime()) {
      validationError(res, 'createdAfter must be earlier than or equal to createdBefore');
      return;
    }
    const filters = {
      q,
      planKey: toSingleParam(req.query.planKey as string | string[] | undefined),
      createdBy: toSingleParam(req.query.createdBy as string | string[] | undefined),
      createdAfter: createdAfter.value,
      createdBefore: createdBefore.value,
      overLimit: overLimit.value
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ createdAt: string; workspaceId: string; signature: string }>(req.query.cursor, signature);
    res.status(200).json(await repo.listAdminWorkspaces({
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      signature,
      ...filters
    }));
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getWorkspace(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const workspace = await repo.getAdminWorkspace(workspaceId);
    if (!workspace) {
      notFound(res, 'Workspace not found');
      return;
    }
    await auditAdmin(req, { action: 'admin.workspace.detail.read', workspaceId, metadata: { highRiskRead: true } });
    res.status(200).json(workspace);
  } catch (err) {
    next(err);
  }
}

export async function patchWorkspacePlan(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const before = await repo.getAdminWorkspace(workspaceId);
    if (!before) {
      notFound(res, 'Workspace not found');
      return;
    }
    let targetPlan;
    try {
      targetPlan = resolveWorkspacePlan(req.body.planKey);
    } catch {
      validationError(res, 'Workspace plan is not configured');
      return;
    }
    const usage = await repo.countWorkspaceUsage(workspaceId);
    const targetLimits = effectiveWorkspaceLimits(targetPlan.key, before.quotaOverrides).quotas;
    const overLimit = {
      members: usage.members > targetLimits.members,
      kubernetesClusters: usage.kubernetesClusters > targetLimits.kubernetesClusters,
      virtualMachines: usage.virtualMachines > targetLimits.virtualMachines
    };
    if (Object.values(overLimit).some(Boolean)) {
      await auditAdmin(req, {
        action: 'admin.workspace.plan.update',
        outcome: 'failure',
        workspaceId,
        reason: req.body.reason,
        metadata: { beforePlan: before.plan.key, requestedPlan: targetPlan.key, usage, targetLimits, overLimit }
      });
      validationError(res, 'Current workspace usage exceeds target plan limits', { usage, targetLimits, overLimit });
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.plan.update',
      workspaceId,
      reason: req.body.reason,
      metadata: { beforePlan: before.plan.key, requestedPlan: targetPlan.key, ticketRef: req.body.ticketRef || null }
    });
    const after = await repo.updateWorkspacePlan(workspaceId, targetPlan.key);
    const correlationId = randomUUID();
    await auditAdmin(req, {
      action: 'admin.workspace.plan.update',
      workspaceId,
      reason: req.body.reason,
      metadata: { beforePlan: before.plan.key, afterPlan: targetPlan.key, correlationId }
    });
    await bestEffortWorkspaceAudit({
      workspaceId,
      tokenId: req.admin.tokenId,
      category: 'workspace',
      eventType: 'workspace.plan.updated.v1',
      objectType: 'workspace',
      objectId: workspaceId,
      objectName: before.name,
      summary: 'Workspace plan updated by admin token',
      metadata: { beforePlan: before.plan.key, afterPlan: targetPlan.key, reason: req.body.reason, correlationId }
    });
    res.status(200).json({ before, after, usage, overLimit });
  } catch (err) {
    next(err);
  }
}

export async function patchWorkspaceQuotas(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const before = await repo.getAdminWorkspace(workspaceId);
    if (!before) {
      notFound(res, 'Workspace not found');
      return;
    }
    const requestedOverrides = req.body.quotas
      ? {
          members: req.body.quotas.members ?? null,
          kubernetesClusters: req.body.quotas.kubernetesClusters ?? null,
          virtualMachines: req.body.quotas.virtualMachines ?? null
        }
      : null;
    const usage = await repo.countWorkspaceUsage(workspaceId);
    const targetLimits = effectiveWorkspaceLimits(before.plan.key, requestedOverrides).quotas;
    const overLimit = {
      members: usage.members > targetLimits.members,
      kubernetesClusters: usage.kubernetesClusters > targetLimits.kubernetesClusters,
      virtualMachines: usage.virtualMachines > targetLimits.virtualMachines
    };
    if (Object.values(overLimit).some(Boolean)) {
      await auditAdmin(req, {
        action: 'admin.workspace.quotas.update',
        outcome: 'failure',
        workspaceId,
        reason: req.body.reason,
        metadata: { before: before.quotaOverrides, requested: requestedOverrides, usage, targetLimits, overLimit }
      });
      validationError(res, 'Current workspace usage exceeds target quota limits', { usage, targetLimits, overLimit });
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.quotas.update',
      workspaceId,
      reason: req.body.reason,
      metadata: { before: before.quotaOverrides, requested: requestedOverrides, ticketRef: req.body.ticketRef || null }
    });
    const after = await repo.setWorkspaceQuotaOverrides(workspaceId, requestedOverrides);
    await auditAdmin(req, {
      action: 'admin.workspace.quotas.update',
      workspaceId,
      reason: req.body.reason,
      metadata: { before: before.quotaOverrides, after: requestedOverrides, ticketRef: req.body.ticketRef || null }
    });
    await bestEffortWorkspaceAudit({
      workspaceId,
      tokenId: req.admin.tokenId,
      category: 'workspace',
      eventType: 'workspace.quotas.updated.v1',
      objectType: 'workspace',
      objectId: workspaceId,
      objectName: before.name,
      summary: 'Workspace quota overrides updated by admin token',
      metadata: { before: before.quotaOverrides, after: requestedOverrides, reason: req.body.reason, ticketRef: req.body.ticketRef || null }
    });
    res.status(200).json({ before, after });
  } catch (err) {
    next(err);
  }
}

export async function listUsers(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = normalizeSearchQuery(req.query.q);
    const emailVerified = parseBoolQuery(req.query.emailVerified, 'emailVerified');
    const authMethod = parseStringFilter(req.query.authMethod, 'authMethod');
    if (emailVerified.error || authMethod.error) {
      validationError(res, emailVerified.error || authMethod.error!);
      return;
    }
    if (authMethod.value && authMethod.value !== 'password' && authMethod.value !== 'oidc') {
      validationError(res, 'authMethod must be password or oidc');
      return;
    }
    const filters = {
      q,
      email: toSingleParam(req.query.email as string | string[] | undefined),
      authMethod: authMethod.value as 'password' | 'oidc' | undefined,
      emailVerified: emailVerified.value
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ createdAt: string; userId: string; signature: string }>(req.query.cursor, signature);
    res.status(200).json(await repo.listAdminUsers({ limit: parseBoundedLimit(req.query.limit), cursor, signature, ...filters }));
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getUser(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = toSingleParam(req.params.userId);
    const detail = await repo.getAdminUser(userId);
    if (!detail) {
      notFound(res, 'User not found');
      return;
    }
    detail.activeSessionCount = await countUserSessions(userId).catch(() => 0);
    await auditAdmin(req, { action: 'admin.user.detail.read', subjectType: 'user', subjectId: userId, metadata: { highRiskRead: true } });
    res.status(200).json(detail);
  } catch (err) {
    next(err);
  }
}

export async function revokeUserSessions(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const userId = toSingleParam(req.params.userId);
    if (!(await repo.getUserById(userId))) {
      notFound(res, 'User not found');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.user.sessions.revoke',
      subjectType: 'user',
      subjectId: userId,
      reason: req.body.reason,
      metadata: { ticketRef: req.body.ticketRef || null }
    });
    const revokedSessionCount = await revokeUserSessionsWithCount(userId);
    await auditAdmin(req, {
      action: 'admin.user.sessions.revoke',
      subjectType: 'user',
      subjectId: userId,
      reason: req.body.reason,
      metadata: { revokedSessionCount, ticketRef: req.body.ticketRef || null }
    });
    res.status(200).json({ revoked: true, revokedSessionCount });
  } catch (err) {
    next(err);
  }
}

export async function addWorkspaceMember(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const workspace = await repo.getAdminWorkspace(workspaceId);
    if (!workspace) {
      notFound(res, 'Workspace not found');
      return;
    }
    if (!isSupportedRole(req.body.role)) {
      validationError(res, 'Workspace role is not supported by this deployment');
      return;
    }
    let userId = req.body.userId as string | undefined;
    let addRequestAudited = false;
    if (!userId && req.body.email) {
      let user = await repo.findUserByEmail(req.body.email);
      if (!user && req.body.createUserIfMissing) {
        const usage = await repo.countWorkspaceUsage(workspaceId);
        const limit = effectiveWorkspaceLimits(workspace.plan.key, workspace.quotaOverrides).quotas.members;
        if (usage.members >= limit) {
          throw new QuotaExceededError('workspaceMembers', usage.members, limit, `Workspace has reached the member limit of ${limit}`);
        }
        await auditAdminMutationRequest(req, {
          action: 'admin.workspace.member.add',
          workspaceId,
          reason: req.body.reason,
          metadata: { email: req.body.email, role: req.body.role, createUserIfMissing: true, ticketRef: req.body.ticketRef || null }
        });
        addRequestAudited = true;
        user = await repo.createVerifiedInternalUser(req.body.email, req.body.email.split('@')[0]);
      }
      if (!user) {
        notFound(res, 'User not found');
        return;
      }
      userId = user.id;
    }
    if (userId && !addRequestAudited) {
      await auditAdminMutationRequest(req, {
        action: 'admin.workspace.member.add',
        workspaceId,
        subjectType: 'user',
        subjectId: userId,
        reason: req.body.reason,
        metadata: { role: req.body.role, ticketRef: req.body.ticketRef || null }
      });
    }
    const result = await repo.addExistingWorkspaceMember(workspaceId, userId!, req.body.role, membershipAudit(req, {
      action: 'admin.workspace.member.add', workspaceId, userId: userId!, reason: req.body.reason,
      eventType: 'workspace.member.added.v1', summary: 'Workspace access granted by a platform administrator',
      metadata: { role: req.body.role, ticketRef: req.body.ticketRef || null }
    }));
    if (result.status === 'user_not_found') {
      notFound(res, 'User not found');
      return;
    }
    if (result.status === 'already_exists') {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'User is already a workspace member', retryable: false } });
      return;
    }
    res.status(201).json(result.member);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      res.status(409).json({ error: { code: 'QUOTA_EXCEEDED', message: err.message, retryable: false, details: { quotaKey: err.quotaKey, used: err.used, limit: err.limit } } });
      return;
    }
    next(err);
  }
}

export async function updateWorkspaceMemberRole(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const userId = toSingleParam(req.params.userId);
    if (!isSupportedRole(req.body.role)) {
      validationError(res, 'Workspace role is not supported by this deployment');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.member.role.update',
      workspaceId,
      subjectType: 'user',
      subjectId: userId,
      reason: req.body.reason,
      metadata: { requestedRole: req.body.role, ticketRef: req.body.ticketRef || null }
    });
    const result = await repo.updateExistingWorkspaceMemberRole(workspaceId, userId, req.body.role, membershipAudit(req, {
      action: 'admin.workspace.member.role.update', workspaceId, userId, reason: req.body.reason,
      eventType: 'workspace.member.role_updated.v1', summary: 'Workspace access role changed by a platform administrator',
      metadata: { afterRole: req.body.role, ticketRef: req.body.ticketRef || null }
    }));
    if (result.status === 'not_found') {
      notFound(res, 'Workspace member not found');
      return;
    }
    if (result.status === 'last_owner') {
      res.status(409).json({ error: { code: 'LAST_OWNER', message: 'Workspace must keep at least one owner', retryable: false } });
      return;
    }
    res.status(200).json(result.member);
  } catch (err) {
    next(err);
  }
}

export async function deleteWorkspaceMember(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const userId = toSingleParam(req.params.userId);
    const current = await repo.getWorkspaceMember(workspaceId, userId);
    if (!current) {
      notFound(res, 'Workspace member not found');
      return;
    }
    if (req.body.replacementOwnerUserId === userId) {
      validationError(res, 'replacementOwnerUserId must be different from the removed member');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.member.delete',
      workspaceId,
      subjectType: 'user',
      subjectId: userId,
      reason: req.body.reason,
      metadata: { previousRole: current.role, replacementOwnerUserId: req.body.replacementOwnerUserId || null, ticketRef: req.body.ticketRef || null }
    });
    const removalAudit = membershipAudit(req, {
      action: 'admin.workspace.member.delete', workspaceId, userId, reason: req.body.reason,
      eventType: 'workspace.member.removed.v1', summary: 'Workspace access revoked by a platform administrator',
      metadata: { previousRole: current.role, ticketRef: req.body.ticketRef || null }
    });
    let result = await repo.deleteExistingWorkspaceMember(workspaceId, userId, removalAudit);
    if (result.status === 'last_owner' && req.body.replacementOwnerUserId) {
      const replacementAudit = membershipAudit(req, {
        action: 'admin.workspace.member.delete', workspaceId, userId, reason: req.body.reason,
        eventType: 'workspace.member.removed.v1', summary: 'Workspace access revoked by a platform administrator',
        metadata: { previousRole: current.role, replacementOwnerUserId: req.body.replacementOwnerUserId, ticketRef: req.body.ticketRef || null },
        extraWorkspaceEvents: [{
          workspaceId, category: 'membership', eventType: 'workspace.member.role_updated.v1', operation: 'write',
          objectType: 'member', objectId: req.body.replacementOwnerUserId,
          summary: 'Workspace owner assigned by a platform administrator', metadata: { afterRole: 'owner' }
        }]
      });
      const replacementResult = await repo.replaceLastOwnerAndDeleteMember(workspaceId, userId, req.body.replacementOwnerUserId, replacementAudit);
      if (replacementResult.status === 'replacement_not_found') {
        validationError(res, 'replacementOwnerUserId must be an existing workspace member');
        return;
      }
      result = replacementResult.status === 'deleted' ? { status: 'deleted', member: replacementResult.member! } : { status: 'not_found' };
    }
    if (result.status === 'last_owner') {
      res.status(409).json({ error: { code: 'LAST_OWNER', message: 'replacementOwnerUserId is required to remove the last owner', retryable: false } });
      return;
    }
    if (result.status === 'not_found') {
      notFound(res, 'Workspace member not found');
      return;
    }
    await cleanupRemovedMemberMcpConnections(workspaceId, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
