import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { summarizeKubernetesSnapshotMetrics } from '../services/target-metric-samples.js';
import { ClusterSnapshot, KUBERNETES_TARGET_TYPE, KubernetesCluster } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import {
  ClusterRow,
  ClusterSnapshotRow,
  mapCluster,
  toIso
} from './repository-mappers.js';
import { replaceClusterSnapshotDerivedRows } from './repository-kubernetes-inventory.js';
import { upsertTargetMetricSample } from './repository-target-metrics.js';
import { withTransaction } from './repository-transaction.js';
import { enqueueTargetAutomationEvent } from './repository-automation-events.js';
import { assertWorkspaceTargetQuota } from './repository-quotas.js';

const clusterSelect = `
  SELECT
    t.id,
    t.workspace_id,
    t.target_type,
    t.name,
    t.status,
    COALESCE(k.namespace_include, '[]'::jsonb) AS namespace_include,
    COALESCE(k.namespace_exclude, '[]'::jsonb) AS namespace_exclude,
    k.write_confirmation_required_override,
    t.created_at,
    t.updated_at
  FROM targets t
  LEFT JOIN kubernetes_target_settings k ON k.target_id = t.id
`;

function isNewerSnapshot(currentTimestamp: string, previousTimestamp: string): boolean {
  const currentTime = Date.parse(currentTimestamp);
  const previousTime = Date.parse(previousTimestamp);
  return Number.isFinite(currentTime) && Number.isFinite(previousTime)
    ? currentTime > previousTime
    : currentTimestamp > previousTimestamp;
}

export async function addCluster(
  workspaceId: string,
  name: string,
  namespaceScope?: { include?: string[]; exclude?: string[] }
): Promise<KubernetesCluster> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    await assertWorkspaceTargetQuota(client, workspaceId, KUBERNETES_TARGET_TYPE);
    await client.query(
      `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
       VALUES ($1, $2, 'kubernetes', $3, 'offline', '{}'::jsonb, $4, $5)`,
      [id, workspaceId, name, now, now]
    );
    await client.query(
      `INSERT INTO kubernetes_target_settings (target_id, namespace_include, namespace_exclude)
       VALUES ($1, $2::jsonb, $3::jsonb)`,
      [
        id,
        JSON.stringify(namespaceScope?.include || []),
        JSON.stringify(namespaceScope?.exclude || [])
      ]
    );
  });
  const cluster = await getCluster(id);
  if (!cluster) {
    throw new Error(`Failed to create Kubernetes target ${id}`);
  }
  return cluster;
}

export async function listClusters(
  workspaceId: string,
  options: {
    limit?: number;
    cursor?: { createdAt: string; clusterId: string } | null;
    q?: string;
    status?: KubernetesCluster['status'];
    signature?: string;
  } = {}
): Promise<PagedResult<KubernetesCluster>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [workspaceId, limit + 1];
  const clauses = ['t.workspace_id = $1', "t.target_type = 'kubernetes'"];
  if (options.status) {
    params.push(options.status);
    clauses.push(`t.status = $${params.length}`);
  }
  if (options.q) {
    params.push(`%${options.q.toLowerCase()}%`);
    clauses.push(`LOWER(t.name) LIKE $${params.length}`);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.clusterId);
    clauses.push(`(t.created_at, t.id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query<ClusterRow>(
    `${clusterSelect}
     WHERE ${clauses.join(' AND ')}
     ORDER BY t.created_at ASC, t.id ASC
     LIMIT $2`,
    params
  );
  return pageWithCursor(result.rows.map(mapCluster), limit, (cluster) =>
    encodeCursor({
      signature: options.signature || '',
      createdAt: cluster.createdAt,
      clusterId: cluster.id
    })
  );
}

export async function getCluster(clusterId: string): Promise<KubernetesCluster | null> {
  const result = await db.query<ClusterRow>(
    `${clusterSelect}
     WHERE t.id = $1
       AND t.target_type = 'kubernetes'`,
    [clusterId]
  );
  if (!result.rowCount) return null;
  return mapCluster(result.rows[0]);
}

export async function updateCluster(
  clusterId: string,
  data: Partial<Pick<KubernetesCluster, 'name' | 'status' | 'namespaceInclude' | 'namespaceExclude' | 'writeConfirmationRequiredOverride'>>
): Promise<KubernetesCluster | null> {
  const cluster = await getCluster(clusterId);
  if (!cluster) return null;

  const name = data.name ?? cluster.name;
  const status = data.status ?? cluster.status;
  const namespaceInclude = data.namespaceInclude ?? cluster.namespaceInclude;
  const namespaceExclude = data.namespaceExclude ?? cluster.namespaceExclude;
  const writeConfirmationRequiredOverride =
    Object.prototype.hasOwnProperty.call(data, 'writeConfirmationRequiredOverride')
      ? data.writeConfirmationRequiredOverride ?? null
      : cluster.writeConfirmationRequiredOverride ?? null;
  const updatedAt = new Date().toISOString();

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE targets
       SET name = $2,
           status = $3,
           updated_at = $4
       WHERE id = $1
         AND target_type = 'kubernetes'`,
      [clusterId, name, status, updatedAt]
    );
    await client.query(
      `INSERT INTO kubernetes_target_settings (
         target_id, namespace_include, namespace_exclude, write_confirmation_required_override
       )
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       ON CONFLICT (target_id) DO UPDATE
       SET namespace_include = EXCLUDED.namespace_include,
           namespace_exclude = EXCLUDED.namespace_exclude,
           write_confirmation_required_override = EXCLUDED.write_confirmation_required_override`,
      [
        clusterId,
        JSON.stringify(namespaceInclude),
        JSON.stringify(namespaceExclude),
        writeConfirmationRequiredOverride
      ]
    );
  });

  return getCluster(clusterId);
}

export async function deleteCluster(clusterId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const clusterResult = await client.query(
      "SELECT 1 FROM targets WHERE id = $1 AND target_type = 'kubernetes' LIMIT 1",
      [clusterId]
    );
    if (!clusterResult.rowCount) {
      return false;
    }

    await client.query('DELETE FROM webhook_history WHERE target_id = $1', [clusterId]);
    await client.query('DELETE FROM webhook_subscriptions WHERE target_id = $1', [clusterId]);
    await client.query('DELETE FROM sessions WHERE target_id = $1', [clusterId]);
    await client.query('DELETE FROM runs WHERE target_id = $1', [clusterId]);
    await client.query('DELETE FROM run_tool_approvals WHERE target_id = $1', [clusterId]);
    await client.query('DELETE FROM targets WHERE id = $1', [clusterId]);
    return true;
  });
}

export async function upsertClusterSnapshot(snapshot: ClusterSnapshot): Promise<void> {
  await withTransaction(async (client) => {
    const clusterResult = await client.query<ClusterRow>(
      `${clusterSelect}
       WHERE t.id = $1
         AND t.target_type = 'kubernetes'`,
      [snapshot.clusterId]
    );
    if (!clusterResult.rowCount) {
      throw new Error(`Cannot upsert snapshot for missing cluster ${snapshot.clusterId}`);
    }
    const cluster = mapCluster(clusterResult.rows[0]);
    const canonicalSnapshot = {
      ...snapshot,
      workspaceId: cluster.workspaceId
    };
    const previousSnapshotResult = await client.query<ClusterSnapshotRow>(
      `SELECT target_id, workspace_id, snapshot_ts, data
       FROM target_snapshots
       WHERE target_id = $1
       FOR UPDATE`,
      [canonicalSnapshot.clusterId]
    );
    const previousSnapshot: ClusterSnapshot | null = previousSnapshotResult.rows.length > 0
      ? {
        clusterId: previousSnapshotResult.rows[0].target_id,
        workspaceId: previousSnapshotResult.rows[0].workspace_id,
        timestamp: toIso(previousSnapshotResult.rows[0].snapshot_ts)!,
        data: previousSnapshotResult.rows[0].data || {}
      }
      : null;
    if (previousSnapshot && !isNewerSnapshot(canonicalSnapshot.timestamp, previousSnapshot.timestamp)) return;
    const payload = JSON.stringify(canonicalSnapshot.data);
    await client.query(
      `INSERT INTO target_snapshots (target_id, workspace_id, snapshot_ts, data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (target_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id,
           snapshot_ts = EXCLUDED.snapshot_ts,
           data = EXCLUDED.data`,
      [canonicalSnapshot.clusterId, canonicalSnapshot.workspaceId, canonicalSnapshot.timestamp, payload]
    );
    const metricSample = summarizeKubernetesSnapshotMetrics(canonicalSnapshot);
    await upsertTargetMetricSample(client, {
      targetId: canonicalSnapshot.clusterId,
      workspaceId: canonicalSnapshot.workspaceId,
      targetType: 'kubernetes',
      timestamp: canonicalSnapshot.timestamp,
      metrics: metricSample
    });
    await replaceClusterSnapshotDerivedRows(client, cluster, canonicalSnapshot, previousSnapshot);
    await enqueueTargetAutomationEvent(client, {
      workspaceId: canonicalSnapshot.workspaceId,
      targetId: canonicalSnapshot.clusterId,
      targetType: 'kubernetes',
      eventType: 'target.snapshot.updated.v1',
      occurrenceKey: canonicalSnapshot.timestamp,
      occurredAt: canonicalSnapshot.timestamp
    });
  });
}

export async function getClusterSnapshot(clusterId: string): Promise<ClusterSnapshot | null> {
  const result = await db.query('SELECT * FROM target_snapshots WHERE target_id = $1', [clusterId]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    clusterId: row.target_id,
    workspaceId: row.workspace_id,
    timestamp: toIso(row.snapshot_ts)!,
    data: row.data || {}
  };
}
