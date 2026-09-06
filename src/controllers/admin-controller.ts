import { randomUUID } from 'node:crypto';
import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { countUserSessions, revokeUserSessionsWithCount } from '../auth/session.js';
import { config } from '../config.js';
import { checkDatabaseHealth } from '../infra/db.js';
import { checkRedisHealth } from '../infra/redis.js';
import { repo } from '../store/repository.js';

import { toSingleParam } from '../utils/params.js';
import { CursorMismatchError, decodeCursor, makeQuerySignature, normalizeSearchQuery, parseBoundedLimit } from '../utils/pagination.js';
import { incrementAdminMutations } from '../metrics.js';
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
export * from './admin-target-run-controller.js';
export * from './admin-audit-controller.js';
export * from './admin-workspace-lifecycle-controller.js';
export * from './admin-workspace-member-search-controller.js';
export * from './admin-platform-settings-controller.js';
export * from './admin-llm-provider-defaults-controller.js';
export * from './admin-workspace-defaults-controller.js';
export * from './admin-workspace-members-controller.js';

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

export async function systemConfig(_req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
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
    res.status(200).json(workspace);
  } catch (err) {
    next(err);
  }
}

export { patchWorkspacePlan, patchWorkspaceQuotas } from './admin-workspace-policy-controller.js';

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
