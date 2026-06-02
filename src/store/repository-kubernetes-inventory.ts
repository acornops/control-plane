import { db } from '../infra/db.js';
import { deriveSnapshotRows } from '../services/snapshot-derived-data.js';
import type {
  ResourceFamily,
  SnapshotClusterSummary,
  SnapshotFindingListItem,
  SnapshotFindingSeverity,
  SnapshotResourceListItem
} from '../services/snapshot-derived-data.js';
import type { KubernetesCluster, ClusterSnapshot } from '../types/domain.js';
import { encodeCursor, pageWithCursor, PagedResult } from '../utils/pagination.js';
import { toIso } from './repository-mappers.js';
import { replaceTargetInventorySnapshot } from './repository-target-inventory.js';
import type { TargetFindingInput, TargetInventoryItemInput } from './repository-target-inventory.js';

interface ResourcePageCursor {
  sortKey: string;
}

interface FindingPageCursor {
  severityRank: number;
  findingTs: string;
  findingId: string;
}

interface SnapshotResourceDerivedDbRow {
  item_id: string;
  family: ResourceFamily;
  kind: string;
  namespace: string | null;
  name: string;
  status: string | null;
  node: string | null;
  item: Record<string, unknown>;
  cluster_id: string;
  cluster_name: string;
  sort_key: string;
}

interface SnapshotFindingDerivedDbRow {
  finding_id: string;
  severity: SnapshotFindingSeverity;
  severity_rank: number;
  title: string;
  message: string;
  finding_ts: Date | string;
  namespace: string | null;
  object_kind: string | null;
  object_name: string | null;
  reason: string | null;
  cluster_id: string;
  cluster_name: string;
}

interface SnapshotSummaryDbRow {
  cluster_id: string;
  workspace_id: string;
  snapshot_ts: Date | string;
  inventory_count: number | string;
  finding_count: number | string;
  critical_finding_count: number | string;
  summary: Record<string, unknown> | null;
}

export interface ClusterSnapshotSummaryRecord {
  latestSnapshot: {
    clusterId: string;
    workspaceId: string;
    timestamp: string;
  };
  summary: SnapshotClusterSummary;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function likePattern(value: string): string {
  return `%${escapeLike(value.toLowerCase())}%`;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'number');
}

function numberFromSummary(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  return typeof value === 'number' ? value : 0;
}

function mapSnapshotResourceRow(row: SnapshotResourceDerivedDbRow): SnapshotResourceListItem {
  return {
    id: row.item_id,
    family: row.family,
    kind: row.kind,
    name: row.name,
    namespace: row.namespace || undefined,
    status: row.status || undefined,
    node: row.node || undefined,
    clusterId: row.cluster_id,
    clusterName: row.cluster_name,
    item: row.item || {}
  };
}

function mapSnapshotFindingRow(row: SnapshotFindingDerivedDbRow): SnapshotFindingListItem {
  return {
    id: row.finding_id,
    severity: row.severity,
    title: row.title,
    message: row.message,
    timestamp: Date.parse(toIso(row.finding_ts)!),
    namespace: row.namespace || undefined,
    objectKind: row.object_kind || undefined,
    objectName: row.object_name || undefined,
    reason: row.reason || undefined,
    clusterId: row.cluster_id,
    clusterName: row.cluster_name
  };
}

function mapSnapshotSummaryRow(row: SnapshotSummaryDbRow): SnapshotClusterSummary {
  const summary = row.summary || {};
  const resourceFamilyCounts = isNumberRecord(summary.resourceFamilyCounts)
    ? summary.resourceFamilyCounts as Record<ResourceFamily, number>
    : {
      workloads: 0,
      network: 0,
      storage: 0,
      cluster: 0
    };
  const resourceKindCounts = isNumberRecord(summary.resourceKindCounts) ? summary.resourceKindCounts : {};
  return {
    resourceCount: Number(row.inventory_count),
    findingCount: Number(row.finding_count),
    criticalFindingCount: Number(row.critical_finding_count),
    namespaceCount: numberFromSummary(summary, 'namespaceCount'),
    nodeCount: numberFromSummary(summary, 'nodeCount'),
    resourceFamilyCounts,
    resourceKindCounts
  };
}

function mapClusterSnapshotSummaryRecord(row: SnapshotSummaryDbRow): ClusterSnapshotSummaryRecord {
  return {
    latestSnapshot: {
      clusterId: row.cluster_id,
      workspaceId: row.workspace_id,
      timestamp: toIso(row.snapshot_ts)!
    },
    summary: mapSnapshotSummaryRow(row)
  };
}

function mapTargetInventoryItems(rows: ReturnType<typeof deriveSnapshotRows>['resources']): TargetInventoryItemInput[] {
  return rows.map((row) => ({
    targetId: row.clusterId,
    workspaceId: row.workspaceId,
    snapshotTs: row.snapshotTs,
    itemId: row.resourceId,
    category: row.family,
    kind: row.kind,
    scopeKind: row.namespace ? 'namespace' : null,
    scopeName: row.namespace,
    name: row.name,
    status: row.status,
    location: row.node,
    needsAttention: row.needsAttention,
    sortKey: row.sortKey,
    searchText: row.searchText,
    item: row.item
  }));
}

function mapTargetFindings(rows: ReturnType<typeof deriveSnapshotRows>['findings']): TargetFindingInput[] {
  return rows.map((row) => ({
    targetId: row.clusterId,
    workspaceId: row.workspaceId,
    snapshotTs: row.snapshotTs,
    findingId: row.findingId,
    severity: row.severity,
    severityRank: row.severityRank,
    scopeKind: row.namespace ? 'namespace' : null,
    scopeName: row.namespace,
    objectKind: row.objectKind,
    objectName: row.objectName,
    title: row.title,
    message: row.message,
    reason: row.reason,
    findingTs: row.findingTs,
    searchText: row.searchText
  }));
}

export async function replaceClusterSnapshotDerivedRows(
  client: Parameters<typeof replaceTargetInventorySnapshot>[0],
  cluster: KubernetesCluster,
  snapshot: ClusterSnapshot
): Promise<void> {
  const derived = deriveSnapshotRows(cluster, snapshot);
  await replaceTargetInventorySnapshot(client, {
    targetId: snapshot.clusterId,
    resources: mapTargetInventoryItems(derived.resources),
    findings: mapTargetFindings(derived.findings),
    summary: {
      targetId: derived.summary.clusterId,
      workspaceId: derived.summary.workspaceId,
      snapshotTs: derived.summary.snapshotTs,
      inventoryCount: derived.summary.resourceCount,
      findingCount: derived.summary.findingCount,
      criticalFindingCount: derived.summary.criticalFindingCount,
      summary: {
        namespaceCount: derived.summary.namespaceCount,
        nodeCount: derived.summary.nodeCount,
        resourceFamilyCounts: derived.summary.resourceFamilyCounts,
        resourceKindCounts: derived.summary.resourceKindCounts
      }
    }
  });
}

export async function getClusterSnapshotSummary(clusterId: string): Promise<ClusterSnapshotSummaryRecord | null> {
  const result = await db.query<SnapshotSummaryDbRow>(
    `SELECT s.target_id AS cluster_id, s.workspace_id, s.snapshot_ts, s.inventory_count, s.finding_count,
       s.critical_finding_count, s.summary
     FROM target_snapshot_summaries s
     JOIN targets t ON t.id = s.target_id AND t.target_type = 'kubernetes'
     WHERE s.target_id = $1`,
    [clusterId]
  );
  if (!result.rowCount) return null;
  return mapClusterSnapshotSummaryRecord(result.rows[0]);
}

export async function listClusterSnapshotSummaries(clusterIds: string[]): Promise<Map<string, ClusterSnapshotSummaryRecord>> {
  if (clusterIds.length === 0) return new Map();
  const result = await db.query<SnapshotSummaryDbRow>(
    `SELECT s.target_id AS cluster_id, s.workspace_id, s.snapshot_ts, s.inventory_count, s.finding_count,
       s.critical_finding_count, s.summary
     FROM target_snapshot_summaries s
     JOIN targets t ON t.id = s.target_id AND t.target_type = 'kubernetes'
     WHERE s.target_id = ANY($1::text[])`,
    [clusterIds]
  );
  return new Map(result.rows.map((row) => [row.cluster_id, mapClusterSnapshotSummaryRecord(row)]));
}

export async function listClusterSnapshotResources(
  clusterId: string,
  options: {
    limit: number;
    cursor?: (ResourcePageCursor & { signature?: string }) | null;
    q?: string;
    family?: string;
    kind?: string;
    namespace?: string;
    health?: string;
    signature?: string;
  }
): Promise<PagedResult<SnapshotResourceListItem>> {
  const limit = Math.max(1, Math.min(200, options.limit));
  const params: Array<string | number | boolean> = [clusterId];
  const clauses = ['r.target_id = $1'];
  if (options.family) {
    params.push(options.family);
    clauses.push(`r.category = $${params.length}`);
  }
  if (options.kind) {
    params.push(options.kind);
    clauses.push(`r.kind = $${params.length}`);
  }
  if (options.namespace) {
    params.push(options.namespace);
    clauses.push(`r.scope_name = $${params.length}`);
  }
  if (options.health === 'attention' || options.health === 'healthy') {
    params.push(options.health === 'attention');
    clauses.push(`r.needs_attention = $${params.length}`);
  }
  if (options.q) {
    params.push(likePattern(options.q));
    clauses.push(`(r.search_text LIKE $${params.length} ESCAPE '\\' OR LOWER(t.name) LIKE $${params.length} ESCAPE '\\')`);
  }
  if (options.cursor?.sortKey) {
    params.push(options.cursor.sortKey);
    clauses.push(`r.sort_key > $${params.length}`);
  }
  params.push(limit + 1);
  const result = await db.query<SnapshotResourceDerivedDbRow>(
    `SELECT r.item_id, r.category AS family, r.kind, r.scope_name AS namespace, r.name, r.status, r.location AS node, r.item,
       r.target_id AS cluster_id, t.name AS cluster_name, r.sort_key
     FROM target_inventory_items r
     JOIN targets t ON t.id = r.target_id AND t.target_type = 'kubernetes'
     WHERE ${clauses.join(' AND ')}
     ORDER BY r.sort_key ASC
     LIMIT $${params.length}`,
    params
  );
  const page = pageWithCursor(result.rows, limit, (row) =>
    encodeCursor({ signature: options.signature || '', sortKey: row.sort_key })
  );
  return {
    items: page.items.map(mapSnapshotResourceRow),
    nextCursor: page.nextCursor
  };
}

function appendFindingFilters(
  clauses: string[],
  params: Array<string | number>,
  options: {
    q?: string;
    severity?: string;
    namespace?: string;
    clusterId?: string;
    cursor?: (FindingPageCursor & { signature?: string }) | null;
  }
): void {
  if (options.severity) {
    params.push(options.severity);
    clauses.push(`f.severity = $${params.length}`);
  }
  if (options.namespace) {
    params.push(options.namespace);
    clauses.push(`f.scope_name = $${params.length}`);
  }
  if (options.clusterId) {
    params.push(options.clusterId);
    clauses.push(`f.target_id = $${params.length}`);
  }
  if (options.q) {
    params.push(likePattern(options.q));
    clauses.push(`(f.search_text LIKE $${params.length} ESCAPE '\\' OR LOWER(t.name) LIKE $${params.length} ESCAPE '\\')`);
  }
  if (options.cursor?.findingTs && options.cursor.findingId && Number.isFinite(Number(options.cursor.severityRank))) {
    params.push(Number(options.cursor.severityRank), options.cursor.findingTs, options.cursor.findingId);
    clauses.push(
      `(f.severity_rank > $${params.length - 2}
        OR (f.severity_rank = $${params.length - 2} AND f.finding_ts < $${params.length - 1}::timestamptz)
        OR (f.severity_rank = $${params.length - 2}
          AND f.finding_ts = $${params.length - 1}::timestamptz
          AND f.finding_id > $${params.length}))`
    );
  }
}

async function listSnapshotFindingsFromSql(
  where: string,
  params: Array<string | number>,
  limit: number,
  signature: string
): Promise<PagedResult<SnapshotFindingListItem>> {
  params.push(limit + 1);
  const result = await db.query<SnapshotFindingDerivedDbRow>(
    `SELECT f.finding_id, f.severity, f.severity_rank, f.title, f.message, f.finding_ts,
       f.scope_name AS namespace, f.object_kind, f.object_name, f.reason, f.target_id AS cluster_id, t.name AS cluster_name
     FROM target_findings f
     JOIN targets t ON t.id = f.target_id AND t.target_type = 'kubernetes'
     WHERE ${where}
     ORDER BY f.severity_rank ASC, f.finding_ts DESC, f.finding_id ASC
     LIMIT $${params.length}`,
    params
  );
  const page = pageWithCursor(result.rows, limit, (row) =>
    encodeCursor({
      signature,
      severityRank: row.severity_rank,
      findingTs: toIso(row.finding_ts),
      findingId: row.finding_id
    })
  );
  return {
    items: page.items.map(mapSnapshotFindingRow),
    nextCursor: page.nextCursor
  };
}

export async function listClusterSnapshotFindings(
  clusterId: string,
  options: {
    limit: number;
    cursor?: (FindingPageCursor & { signature?: string }) | null;
    q?: string;
    severity?: string;
    namespace?: string;
    signature?: string;
  }
): Promise<PagedResult<SnapshotFindingListItem>> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const params: Array<string | number> = [clusterId];
  const clauses = ['f.target_id = $1'];
  appendFindingFilters(clauses, params, options);
  return listSnapshotFindingsFromSql(clauses.join(' AND '), params, limit, options.signature || '');
}

export async function listWorkspaceSnapshotFindings(
  workspaceId: string,
  options: {
    limit: number;
    cursor?: (FindingPageCursor & { signature?: string }) | null;
    q?: string;
    severity?: string;
    namespace?: string;
    clusterId?: string;
    signature?: string;
  }
): Promise<PagedResult<SnapshotFindingListItem>> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const params: Array<string | number> = [workspaceId];
  const clauses = ['f.workspace_id = $1'];
  appendFindingFilters(clauses, params, options);
  return listSnapshotFindingsFromSql(clauses.join(' AND '), params, limit, options.signature || '');
}
