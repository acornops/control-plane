import { NextFunction, Response } from 'express';
import { agentGateway } from '../../agent/ws-server.js';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import {
  requireClusterAccess,
  requireWorkspaceCapability,
  requireWorkspaceDataRead
} from '../../auth/workspace-authorization.js';
import { logger } from '../../logger.js';
import { webhooks } from '../../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { repo } from '../../store/repository.js';
import { KUBERNETES_TARGET_TYPE } from '../../types/domain.js';
import { generateAgentKey, hashSecret } from '../../utils/crypto.js';
import { toSingleParam } from '../../utils/params.js';
import {
  buildAgentInstallInstructions,
  clusterAllowsNamespace,
  normalizeNamespaceList,
  parseBooleanQuery,
  parseBoundedIntQuery,
  parseMetricLimit,
  parseMetricWindowMs,
  parseOptionalPositiveIntQuery,
  summarizeSnapshotMetrics
} from './kubernetes-cluster-request-utils.js';

export async function registerCluster(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_targets',
        'Only workspace roles with target management capability can register clusters'
      ))
    ) {
      return;
    }

    const cluster = await repo.addCluster(workspaceId, req.body.name, {
      include: normalizeNamespaceList(req.body.namespaceInclude),
      exclude: normalizeNamespaceList(req.body.namespaceExclude)
    });
    const rawAgentKey = generateAgentKey(cluster.id);

    await repo.upsertTargetAgentRegistration({
      targetId: cluster.id,
      targetType: KUBERNETES_TARGET_TYPE,
      workspaceId: cluster.workspaceId,
      agentKeyHash: hashSecret(rawAgentKey),
      keyVersion: 1
    });

    webhooks.emit({
      type: 'target.registered.v1',
      workspaceId,
      clusterId: cluster.id,
      targetId: cluster.id,
      targetType: KUBERNETES_TARGET_TYPE,
      subject: { type: 'target', id: cluster.id },
      data: {
        targetType: KUBERNETES_TARGET_TYPE,
        name: cluster.name,
        status: cluster.status,
        createdAt: cluster.createdAt
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'target.registered.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      targetType: 'kubernetes_cluster',
      targetId: cluster.id,
      targetName: cluster.name,
      summary: 'Kubernetes cluster registered',
      metadata: {
        status: cluster.status,
        namespaceInclude: cluster.namespaceInclude,
        namespaceExclude: cluster.namespaceExclude
      }
    });
    res.status(201).json({
      cluster,
      agentKey: rawAgentKey,
      installInstructions: buildAgentInstallInstructions(cluster, rawAgentKey)
    });
  } catch (err) {
    next(err);
  }
}

function parseClusterIdsParam(value: string | string[] | undefined, maxItems: number): string[] {
  const seen = new Set<string>();
  const clusterIds: string[] = [];
  for (const clusterId of toSingleParam(value).split(',')) {
    const trimmed = clusterId.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    clusterIds.push(trimmed);
    if (clusterIds.length >= maxItems) {
      break;
    }
  }
  return clusterIds;
}

export async function getWorkspaceClusterMetricsHistory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) {
      return;
    }

    const clusterIds = parseClusterIdsParam(req.query.clusterIds as string | string[] | undefined, 20);
    const windowMs = parseMetricWindowMs(req.query.window);
    const limit = parseMetricLimit(req.query.limit);
    const since = new Date(Date.now() - windowMs).toISOString();
    const items = [];

    for (const clusterId of clusterIds) {
      const cluster = await repo.getCluster(clusterId);
      if (!cluster || cluster.workspaceId !== workspaceId) {
        continue;
      }
      const snapshots = await repo.listClusterSnapshotHistory(clusterId, { since, limit });
      items.push({
        clusterId,
        points: snapshots
          .filter((snapshot) => snapshot.workspaceId === workspaceId)
          .map(summarizeSnapshotMetrics)
          .filter((point): point is NonNullable<typeof point> => point !== null)
      });
    }

    res.status(200).json({
      workspaceId,
      windowMs,
      items
    });
  } catch (err) {
    next(err);
  }
}

export async function getClusterMetricsHistory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    if (!(await requireClusterAccess(req, res, workspaceId, clusterId))) {
      return;
    }

    const windowMs = parseMetricWindowMs(req.query.window);
    const limit = parseMetricLimit(req.query.limit);
    const since = new Date(Date.now() - windowMs).toISOString();
    const snapshots = await repo.listClusterSnapshotHistory(clusterId, { since, limit });
    const points = snapshots
      .filter((snapshot) => snapshot.workspaceId === workspaceId)
      .map(summarizeSnapshotMetrics)
      .filter((point): point is NonNullable<typeof point> => point !== null);

    res.status(200).json({
      workspaceId,
      clusterId,
      windowMs,
      points
    });
  } catch (err) {
    next(err);
  }
}

export async function getPodLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const namespace = toSingleParam(req.params.namespace);
    const podName = toSingleParam(req.params.podName);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return;
    }

    const cluster = access.cluster;
    if (!clusterAllowsNamespace(cluster, namespace)) {
      res.status(403).json({
        error: {
          code: 'NAMESPACE_NOT_ALLOWED',
          message: 'This namespace is outside the cluster namespace scope',
          retryable: false
        }
      });
      return;
    }

    if (!access.authz.can('read_target_logs')) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Only workspace operators/admins/owners can read pod logs', retryable: false }
      });
      return;
    }

    const container = typeof req.query.container === 'string' && req.query.container.trim().length > 0
      ? req.query.container.trim()
      : undefined;
    const previous = parseBooleanQuery(req.query.previous);
    const tailLines = parseBoundedIntQuery(req.query.tailLines || req.query.tail_lines, 200, 1, 5000);
    const sinceSeconds = parseOptionalPositiveIntQuery(req.query.sinceSeconds || req.query.since_seconds, 30 * 24 * 60 * 60);
    const limitBytes = parseBoundedIntQuery(req.query.limitBytes || req.query.limit_bytes, 1024 * 1024, 1, 10 * 1024 * 1024);

    const startedAt = Date.now();
    try {
      const result = await agentGateway.callAgentTool(clusterId, 'get_resource_logs', {
        name: podName,
        namespace,
        container,
        previous,
        tail_lines: tailLines,
        since_seconds: sinceSeconds,
        limit_bytes: limitBytes
      });
      const payload = typeof result === 'object' && result !== null
        ? result as { logs?: unknown; container?: unknown }
        : {};
      const logs = typeof payload.logs === 'string'
        ? payload.logs
        : typeof result === 'string'
          ? result
          : JSON.stringify(result);

      webhooks.emit({
        type: 'tool.called.v1',
        workspaceId,
        clusterId,
        targetId: clusterId,
        targetType: KUBERNETES_TARGET_TYPE,
        subject: { type: 'tool_call', id: `${clusterId}:get_resource_logs:${Date.now()}` },
        data: {
          toolName: 'get_resource_logs',
          source: 'management_console_pod_logs',
          durationMs: Date.now() - startedAt,
          isError: false
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'tool',
        eventType: 'tool.called.v1',
        operation: 'read',
        actorUserId: req.auth.userId,
        targetType: 'tool_call',
        targetId: `${clusterId}:get_resource_logs:${startedAt}`,
        targetName: 'get_resource_logs',
        summary: 'Cluster tool called',
        metadata: {
          targetId: clusterId,
          targetType: KUBERNETES_TARGET_TYPE,
          toolName: 'get_resource_logs',
          source: 'management_console_pod_logs',
          durationMs: Date.now() - startedAt,
          isError: false
        }
      });

      res.status(200).json({
        name: podName,
        namespace,
        container: typeof payload.container === 'string' ? payload.container : container || '',
        logs,
        tailLines,
        previous,
        fetchedAt: new Date().toISOString()
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent log request failed';
      webhooks.emit({
        type: 'tool.called.v1',
        workspaceId,
        clusterId,
        targetId: clusterId,
        targetType: KUBERNETES_TARGET_TYPE,
        subject: { type: 'tool_call', id: `${clusterId}:get_resource_logs:${Date.now()}` },
        data: {
          toolName: 'get_resource_logs',
          source: 'management_console_pod_logs',
          durationMs: Date.now() - startedAt,
          isError: true,
          error: message
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'tool',
        eventType: 'tool.called.v1',
        operation: 'read',
        actorUserId: req.auth.userId,
        targetType: 'tool_call',
        targetId: `${clusterId}:get_resource_logs:${startedAt}`,
        targetName: 'get_resource_logs',
        summary: 'Cluster tool call failed',
        metadata: {
          targetId: clusterId,
          targetType: KUBERNETES_TARGET_TYPE,
          toolName: 'get_resource_logs',
          source: 'management_console_pod_logs',
          durationMs: Date.now() - startedAt,
          isError: true
        }
      });

      const status = /not connected|timed out/i.test(message) ? 503 : 502;
      res.status(status).json({
        error: {
          code: status === 503 ? 'AGENT_UNAVAILABLE' : 'AGENT_TOOL_ERROR',
          message,
          retryable: status === 503
        }
      });
    }
  } catch (err) {
    next(err);
  }
}

export async function updateCluster(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return;
    }
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_targets',
        'Only workspace roles with target management capability can update clusters'
      ))
    ) {
      return;
    }

    const cluster = access.cluster;

    const requestedName = typeof req.body?.name === 'string' ? req.body.name : undefined;
    const namespaceInclude = req.body.namespaceInclude === undefined
      ? undefined
      : normalizeNamespaceList(req.body.namespaceInclude);
    const namespaceExclude = req.body.namespaceExclude === undefined
      ? undefined
      : normalizeNamespaceList(req.body.namespaceExclude);
    const writeConfirmationRequiredOverride =
      Object.prototype.hasOwnProperty.call(req.body, 'writeConfirmationRequiredOverride')
        ? req.body.writeConfirmationRequiredOverride
        : undefined;
    const updated = await repo.updateCluster(clusterId, {
      name: requestedName,
      namespaceInclude,
      namespaceExclude,
      writeConfirmationRequiredOverride
    });

    const scopeChanged = Boolean(updated) && (
      (namespaceInclude !== undefined &&
        JSON.stringify(namespaceInclude) !== JSON.stringify(cluster.namespaceInclude)) ||
      (namespaceExclude !== undefined &&
        JSON.stringify(namespaceExclude) !== JSON.stringify(cluster.namespaceExclude))
    );
    const writeConfirmationChanged = Boolean(updated) &&
      writeConfirmationRequiredOverride !== undefined &&
      writeConfirmationRequiredOverride !== (cluster.writeConfirmationRequiredOverride ?? null);
    if (updated && ((requestedName !== undefined && requestedName !== cluster.name) || scopeChanged || writeConfirmationChanged)) {
      if (scopeChanged) {
        agentGateway
          .updateNamespaceScope(clusterId, {
            include: updated.namespaceInclude,
            exclude: updated.namespaceExclude
          })
          .catch((err) => {
            logger.warn({ err, clusterId }, 'Failed to push namespace scope update to connected agent');
          });
      }

      webhooks.emit({
        type: 'target.updated.v1',
        workspaceId,
        clusterId,
        targetId: clusterId,
        targetType: KUBERNETES_TARGET_TYPE,
        subject: { type: 'target', id: clusterId },
        data: {
          targetType: KUBERNETES_TARGET_TYPE,
          name: updated.name,
          status: updated.status,
          namespaceInclude: updated.namespaceInclude,
          namespaceExclude: updated.namespaceExclude,
          writeConfirmationPolicy: updated.writeConfirmationPolicy,
          updatedAt: updated.updatedAt
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'target',
        eventType: 'target.updated.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        targetType: 'kubernetes_cluster',
        targetId: clusterId,
        targetName: updated.name,
        summary: 'Kubernetes cluster settings updated',
        metadata: {
          nameChanged: requestedName !== undefined && requestedName !== cluster.name,
          namespaceScopeChanged: scopeChanged,
          writeConfirmationChanged
        }
      });
    }
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

export async function rotateAgentKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return;
    }
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_agent_keys',
        'Only workspace roles with agent-key management capability can rotate agent keys'
      ))
    ) {
      return;
    }

    const reg = await repo.getTargetAgentRegistration(clusterId);
    if (!reg) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent registration not found', retryable: false } });
      return;
    }

    const rawAgentKey = generateAgentKey(clusterId);
    await repo.upsertTargetAgentRegistration({
      ...reg,
      agentKeyHash: hashSecret(rawAgentKey),
      keyVersion: reg.keyVersion + 1
    });
    await agentGateway.disconnectCluster(clusterId, 'Agent key rotated');

    webhooks.emit({
      type: 'agent.key_rotated.v1',
      workspaceId,
      clusterId,
      targetId: clusterId,
      targetType: KUBERNETES_TARGET_TYPE,
      subject: { type: 'agent', id: clusterId },
      data: {
        keyVersion: reg.keyVersion + 1,
        rotatedBy: req.auth.userId
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'agent.key_rotated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      targetType: 'kubernetes_cluster',
      targetId: clusterId,
      targetName: access.cluster.name,
      summary: 'Cluster agent key rotated',
      metadata: { keyVersion: reg.keyVersion + 1 }
    });
    res.status(200).json({
      clusterId,
      agentKey: rawAgentKey,
      keyVersion: reg.keyVersion + 1,
      installInstructions: buildAgentInstallInstructions(access.cluster, rawAgentKey)
    });
  } catch (err) {
    next(err);
  }
}

export {
  getCluster,
  listClusterFindings,
  listClusterResources,
  listClusters
} from './kubernetes-cluster-snapshot-controller.js';
