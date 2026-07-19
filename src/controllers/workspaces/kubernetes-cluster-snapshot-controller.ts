import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import {
  requireClusterAccess,
  requireWorkspaceDataRead
} from '../../auth/workspace-authorization.js';
import type { SnapshotClusterSummary } from '../../services/snapshot-derived-data.js';
import { repo } from '../../store/repository.js';
import { KubernetesCluster } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../../utils/pagination.js';

const emptySnapshotSummary: SnapshotClusterSummary = {
  resourceCount: 0,
  findingCount: 0,
  criticalFindingCount: 0,
  namespaceCount: 0,
  nodeCount: 0,
  resourceFamilyCounts: {
    workloads: 0,
    network: 0,
    storage: 0,
    cluster: 0
  },
  resourceKindCounts: {}
};

export async function listClusters(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) {
      return;
    }

    const q = normalizeSearchQuery(req.query.q);
    const status = toSingleParam(req.query.status as string | string[] | undefined);
    const filters: { q: string; status?: KubernetesCluster['status'] } = {
      q,
      status: status === 'online' || status === 'offline' || status === 'degraded' || status === 'unknown' ? status : undefined
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ createdAt: string; clusterId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listClusters(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      q,
      status: filters.status,
      signature
    });
    const summaryRecords = await repo.listClusterSnapshotSummaries(page.items.map((cluster) => cluster.id));
    const items = page.items.map((cluster) => {
      const snapshotRecord = summaryRecords.get(cluster.id);
      return {
        ...cluster,
        latestSnapshot: snapshotRecord?.latestSnapshot || null,
        summary: snapshotRecord?.summary || emptySnapshotSummary
      };
    });
    res.status(200).json({ items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getCluster(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return;
    }

    const snapshotRecord = await repo.getClusterSnapshotSummary(clusterId);
    res.status(200).json({
      ...access.cluster,
      latestSnapshot: snapshotRecord?.latestSnapshot || null,
      summary: snapshotRecord?.summary || emptySnapshotSummary
    });
  } catch (err) {
    next(err);
  }
}

export async function listClusterResources(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const clusterId = toSingleParam(req.params.clusterId);
    const access = await requireClusterAccess(req, res, workspaceId, clusterId);
    if (!access) {
      return;
    }
    const q = normalizeSearchQuery(req.query.q);
    const filters = {
      q,
      family: toSingleParam(req.query.family as string | string[] | undefined),
      kind: toSingleParam(req.query.kind as string | string[] | undefined),
      namespace: toSingleParam(req.query.namespace as string | string[] | undefined),
      health: toSingleParam(req.query.health as string | string[] | undefined)
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ sortKey: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listClusterSnapshotResources(clusterId, {
      limit: parseBoundedLimit(req.query.limit, 100, 200),
      cursor,
      q,
      family: filters.family,
      kind: filters.kind,
      namespace: filters.namespace,
      health: filters.health,
      namespaceInclude: access.cluster.namespaceInclude,
      namespaceExclude: access.cluster.namespaceExclude,
      signature
    });
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}
